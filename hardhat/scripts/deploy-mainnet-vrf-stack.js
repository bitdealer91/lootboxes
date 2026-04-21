import hre from "hardhat";
const { ethers } = hre;

// Deploy mainnet VRF stack:
// OdysseyKeys (existing ERC1155) -> Mixer (BURN mode) -> LootboxKey -> SomniaLootboxVRF (VRF) + RewardVaultERC721 (Quills)
//
// Run:
// SOMNIA_RPC_URL=https://api.infra.mainnet.somnia.network DEPLOYER_PRIVATE_KEY=0x... \
// ODYSSEY_KEYS_ADDRESS=0x2d53...5306 QUILLS_ERC721_ADDRESS=0x9078...28a3 \
// FUND_VRF_NATIVE=0.5 \
// npx hardhat run ./scripts/deploy-mainnet-vrf-stack.js --network somnia
//
// Optional:
// VRF_WRAPPER=0x606b... (defaults to Somnia mainnet wrapper)
// VRF_CALLBACK_GAS=1000000
// VRF_CONFIRMATIONS=3
// QUILLS_COUNT=0
// CONSUME_TO=0x...   (ignored in BURN mode; kept for optional ESCROW recipes)
// RECIPE_ID=1
// LOCK_CONFIG=true   (locks the lootbox config and enables opening; default: false)

async function main() {
  await hre.run("compile");

  if (hre.network.name !== "somnia") {
    throw new Error("Run with: --network somnia");
  }

  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log("Network:", hre.network.name, "chainId:", net.chainId.toString());
  console.log("Deployer:", deployer.address);
  const deployerBal = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer native balance:", ethers.formatEther(deployerBal));

  const odysseyKeys = process.env.ODYSSEY_KEYS_ADDRESS;
  if (!odysseyKeys) throw new Error("Set ODYSSEY_KEYS_ADDRESS");

  const quillsErc721 = process.env.QUILLS_ERC721_ADDRESS;
  if (!quillsErc721) throw new Error("Set QUILLS_ERC721_ADDRESS");

  const recipeId = BigInt(process.env.RECIPE_ID || "1");

  const vrfWrapper = process.env.VRF_WRAPPER || "0x606b2B36516AB7479D1445Ec14B6B39B44901bf8";
  const vrfCallbackGas = Number.parseInt(process.env.VRF_CALLBACK_GAS || "1000000", 10);
  const vrfConfirmations = Number.parseInt(process.env.VRF_CONFIRMATIONS || "3", 10);
  if (!Number.isFinite(vrfCallbackGas) || vrfCallbackGas <= 0) throw new Error("Bad VRF_CALLBACK_GAS");
  if (!Number.isFinite(vrfConfirmations) || vrfConfirmations <= 0) throw new Error("Bad VRF_CONFIRMATIONS");

  const LootboxKey = await ethers.getContractFactory("LootboxKey");
  const lootboxKey = await LootboxKey.deploy("");
  await lootboxKey.waitForDeployment();

  const Mixer = await ethers.getContractFactory("Mixer");
  const mixer = await Mixer.deploy();
  await mixer.waitForDeployment();

  await (await lootboxKey.grantRole(await lootboxKey.MINTER_ROLE(), await mixer.getAddress())).wait();

  await (await lootboxKey.setMixer(await mixer.getAddress())).wait();

  const consumeTo = process.env.CONSUME_TO || ethers.ZeroAddress;

  // Recipe: 8 Odyssey keys (ids 1..8) => 1 lootbox key id=1 (BURN: keys consumed on-chain)
  await (
    await mixer.setRecipe(recipeId, {
      tokenType: 0,
      inputToken: odysseyKeys,
      minId: 1,
      maxId: 8,
      requiredTotal: 8,
      mode: 1,
      consumeTo,
      outputKey: await lootboxKey.getAddress(),
      outputKeyId: 1,
      outputAmount: 1,
      enabled: true
    })
  ).wait();

  const RewardVaultERC721 = await ethers.getContractFactory("RewardVaultERC721");
  const quillsVault = await RewardVaultERC721.deploy(quillsErc721);
  await quillsVault.waitForDeployment();

  const SomniaLootboxVRFS5 = await ethers.getContractFactory("SomniaLootboxVRFS5");
  const lootbox = await SomniaLootboxVRFS5.deploy(
    await lootboxKey.getAddress(),
    vrfWrapper,
    vrfCallbackGas,
    vrfConfirmations
  );
  await lootbox.waitForDeployment();

  await (await quillsVault.setLootbox(await lootbox.getAddress())).wait();
  await (await lootboxKey.grantRole(await lootboxKey.MINTER_ROLE(), await lootbox.getAddress())).wait();

  console.log("Granted LootboxKey MINTER_ROLE to SomniaLootboxVRF (VRF recovery remints keys).");

  const quillsCount = Number.parseInt(process.env.QUILLS_COUNT || "0", 10);
  if (!Number.isFinite(quillsCount) || quillsCount < 0) throw new Error("Bad QUILLS_COUNT");

  // itemType 0..5: points (S5); itemType 6: Quills via vault (claimErc721 -> vault.dispense)
  await (await lootbox.setPrize(0, 26000, 3, ethers.ZeroAddress, 125)).wait();
  await (await lootbox.setPrize(1, 22000, 3, ethers.ZeroAddress, 180)).wait();
  await (await lootbox.setPrize(2, 16000, 3, ethers.ZeroAddress, 250)).wait();
  await (await lootbox.setPrize(3, 14000, 3, ethers.ZeroAddress, 300)).wait();
  await (await lootbox.setPrize(4, 10800, 3, ethers.ZeroAddress, 375)).wait();
  await (await lootbox.setPrize(5, 8688, 3, ethers.ZeroAddress, 500)).wait();
  await (await lootbox.setPrize(6, quillsCount, 2, await quillsVault.getAddress(), 1)).wait();
  const lock = (process.env.LOCK_CONFIG || "").toLowerCase();
  if (lock === "1" || lock === "true" || lock === "yes") {
    await (await lootbox.lockConfig()).wait();
  } else {
    console.log("\nNOTE: Lootbox config is NOT locked yet (opening is disabled).");
    console.log("After funding Quills vault + VRF balance, run finalize script to lock config:");
    console.log("  npx hardhat run ./scripts/finalize-mainnet-lootbox.js --network somnia");
  }

  // Fund lootbox with native SOMI so it can pay VRF wrapper fees (UI doesn't need to send msg.value).
  const fund = process.env.FUND_VRF_NATIVE || "0";
  const fundWei = ethers.parseEther(fund);
  if (fundWei > 0n) {
    const gasReserveWei = ethers.parseEther("0.05");
    if (deployerBal < fundWei + gasReserveWei) {
      throw new Error(
        `Not enough native token to fund VRF fees. FUND_VRF_NATIVE=${fund}, balance=${ethers.formatEther(deployerBal)}.`
      );
    }
    await (await deployer.sendTransaction({ to: await lootbox.getAddress(), value: fundWei })).wait();
  }

  const deployed = {
    chainId: Number(net.chainId),
    rpc: process.env.SOMNIA_RPC_URL || "https://api.infra.mainnet.somnia.network",
    odysseyKeys,
    mixer: await mixer.getAddress(),
    lootboxKey: await lootboxKey.getAddress(),
    lootbox: await lootbox.getAddress(),
    vrfWrapper,
    quillsErc721,
    quillsVault: await quillsVault.getAddress(),
    recipeId: Number(recipeId),
    consumeTo
  };

  console.log("\nDeployed (mainnet VRF):");
  console.log(JSON.stringify(deployed, null, 2));

  console.log("\nPaste into /Users/maksim/projects/lootboxes/.env.local:");
  console.log(
    [
      `NEXT_PUBLIC_CHAIN_ID=${deployed.chainId}`,
      `NEXT_PUBLIC_CHAIN_NAME=\"Somnia Mainnet\"`,
      `NEXT_PUBLIC_CHAIN_SYMBOL=SOMI`,
      `NEXT_PUBLIC_RPC_URL=${deployed.rpc}`,
      `NEXT_PUBLIC_INPUT_KEYS_ADDRESS=${deployed.odysseyKeys}`,
      `NEXT_PUBLIC_MIXER_ADDRESS=${deployed.mixer}`,
      `NEXT_PUBLIC_LOOTBOX_KEY_ADDRESS=${deployed.lootboxKey}`,
      `NEXT_PUBLIC_LOOTBOX_ADDRESS=${deployed.lootbox}`,
      `NEXT_PUBLIC_RECIPE_ID=${deployed.recipeId}`,
      `NEXT_PUBLIC_MIX_REQUIRED_TOTAL=8`,
      `NEXT_PUBLIC_NFT_ITEM_TYPE=6`,
      `NEXT_PUBLIC_INPUT_KEY_IDS=1,2,3,4,5,6,7,8`,
      `NEXT_PUBLIC_LOOTBOX_KEY_IDS=1`,
      `NEXT_PUBLIC_EXPLORER_TX_BASE=https://explorer.somnia.network/tx/`
    ].join("\n")
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

