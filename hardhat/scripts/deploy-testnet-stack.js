import hre from "hardhat";
const { ethers } = hre;

// Deploy testnet stack:
// TestKeys1155 (faucet ids 1..8) -> Mixer (100 any ids) -> LootboxKey -> TestLootboxInstant
//
// Run:
// SOMNIA_TEST_RPC_URL=https://dream-rpc.somnia.network DEPLOYER_PRIVATE_KEY=0x... \
//   npx hardhat run ./scripts/deploy-testnet-stack.js --network somniaTest

async function main() {
  await hre.run("compile");

  if (hre.network.name !== "somniaTest") {
    throw new Error("Run with: --network somniaTest");
  }

  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log("Network:", hre.network.name, "chainId:", net.chainId.toString());
  console.log("Deployer:", deployer.address);
  const deployerBal = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer native STT balance:", ethers.formatEther(deployerBal));

  const TestKeys1155 = await ethers.getContractFactory("TestKeys1155");
  const inputKeys = await TestKeys1155.deploy("ipfs://test-keys/");
  await inputKeys.waitForDeployment();

  const LootboxKey = await ethers.getContractFactory("LootboxKey");
  const lootboxKey = await LootboxKey.deploy("");
  await lootboxKey.waitForDeployment();

  const Mixer = await ethers.getContractFactory("Mixer");
  const mixer = await Mixer.deploy();
  await mixer.waitForDeployment();

  // Allow mixer to mint lootbox keys
  await (await lootboxKey.grantRole(await lootboxKey.MINTER_ROLE(), await mixer.getAddress())).wait();

  // Recipe #1: 32 any ids 1..8 => 1 lootbox key id=1
  await (
    await mixer.setRecipe(1, {
      tokenType: 0,
      inputToken: await inputKeys.getAddress(),
      minId: 1,
      maxId: 8,
      requiredTotal: 32,
      mode: 0,
      consumeTo: await mixer.getAddress(),
      outputKey: await lootboxKey.getAddress(),
      outputKeyId: 1,
      outputAmount: 1,
      enabled: true
    })
  ).wait();

  // Rewards
  // NOTE: native STT (testnet currency) is used for token prizes.

  const MockERC721 = await ethers.getContractFactory("MockERC721");
  const quills = await MockERC721.deploy("Quills", "QUILLS");
  await quills.waitForDeployment();

  const RewardVaultERC721 = await ethers.getContractFactory("RewardVaultERC721");
  const quillsVault = await RewardVaultERC721.deploy(await quills.getAddress());
  await quillsVault.waitForDeployment();

  const TestLootboxInstant = await ethers.getContractFactory("TestLootboxInstant");
  const lootbox = await TestLootboxInstant.deploy(await lootboxKey.getAddress());
  await lootbox.waitForDeployment();

  // Configure the vault to allow lootbox dispensing
  await (await quillsVault.setLootbox(await lootbox.getAddress())).wait();

  // Mint and deposit 5 NFTs into the vault (deployer as depositor)
  // tokenIds will be 1..5 in MockERC721
  for (let i = 0; i < 5; i++) {
    await (await quills.mint(deployer.address)).wait();
  }
  await (await quills.setApprovalForAll(await quillsVault.getAddress(), true)).wait();
  await (await quillsVault.deposit([1, 2, 3, 4, 5])).wait();

  // Configure Odyssey loot table (always win).
  // Total lootboxes: 24,521 (sum of remaining).
  // itemType 0: Quills via vault address (claimErc721 will call vault.dispense)
  await (await lootbox.setPrize(0, 5, 2, await quillsVault.getAddress(), 1)).wait();
  // Native token rewards (SOMI/STT on current chain), funded via contract balance.
  await (await lootbox.setPrize(1, 4000, 1, ethers.ZeroAddress, ethers.parseEther("30"))).wait();
  await (await lootbox.setPrize(2, 3000, 1, ethers.ZeroAddress, ethers.parseEther("50"))).wait();
  await (await lootbox.setPrize(3, 2000, 1, ethers.ZeroAddress, ethers.parseEther("75"))).wait();
  await (await lootbox.setPrize(4, 400, 1, ethers.ZeroAddress, ethers.parseEther("200"))).wait();
  // Points (on-chain counter in the lootbox)
  await (await lootbox.setPrize(5, 6000, 3, ethers.ZeroAddress, 750)).wait();
  await (await lootbox.setPrize(6, 4000, 3, ethers.ZeroAddress, 1000)).wait();
  await (await lootbox.setPrize(7, 2600, 3, ethers.ZeroAddress, 1500)).wait();
  await (await lootbox.setPrize(8, 1516, 3, ethers.ZeroAddress, 1750)).wait();
  await (await lootbox.setPrize(9, 1000, 3, ethers.ZeroAddress, 2000)).wait();
  await (await lootbox.lockConfig()).wait();

  // Fund native STT for claims
  // Recommended pool for token rewards: 500,000 (sum of payouts in the table).
  console.log("Recommended native token pool for claims:", "500000");
  const fund = process.env.FUND_NATIVE_STT || "0";
  const fundWei = ethers.parseEther(fund);
  if (fundWei > 0n) {
    // Keep a small reserve to pay gas for future admin calls
    const gasReserveWei = ethers.parseEther("0.02");
    if (deployerBal < fundWei + gasReserveWei) {
      throw new Error(
        `Not enough native STT to fund lootbox. Requested FUND_NATIVE_STT=${fund} STT, ` +
          `but balance=${ethers.formatEther(deployerBal)} STT. ` +
          `Top up deployer with STT or lower FUND_NATIVE_STT (e.g. 1-10).`
      );
    }
    await (await deployer.sendTransaction({ to: await lootbox.getAddress(), value: fundWei })).wait();
  }

  console.log("\nDeployed:");
  console.log(JSON.stringify({
    chainId: Number(net.chainId),
    rpc: process.env.SOMNIA_TEST_RPC_URL || "https://dream-rpc.somnia.network",
    inputKeys: await inputKeys.getAddress(),
    mixer: await mixer.getAddress(),
    lootboxKey: await lootboxKey.getAddress(),
    lootbox: await lootbox.getAddress(),
    stt: "native",
    quills: await quills.getAddress(),
    quillsVault: await quillsVault.getAddress(),
    recipeId: 1
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});


