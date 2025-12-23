import hre from "hardhat";
const { ethers } = hre;

// Local-only mechanics test:
// 1) Deploy Keys1155 (EIP712 mintWithSig), Mixer, LootboxKey, Lootbox, mock reward tokens
// 2) Mint input keys to a user, mix into lootbox key, open lootbox
// 3) Force each reward (itemType 0..4) deterministically via fulfillRandomness
//
// Run:
//   npx hardhat run ./scripts/test-flow-local.js

function decodeReceiptEvents(receipt, iface) {
  return receipt.logs
    .map((log) => {
      try {
        return iface.parseLog(log);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function main() {
  await hre.run("compile");

  const [deployer, user, rng] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("User:", user.address);
  console.log("RngProvider:", rng.address);

  // Deploy test input keys (ids 1..8, mintWithSig)
  const Keys1155 = await ethers.getContractFactory("Keys1155");
  const inputKeys = await Keys1155.connect(deployer).deploy("ipfs://base/", deployer.address);
  await inputKeys.waitForDeployment();

  // Deploy lootbox key (ERC1155 burnable)
  const LootboxKey = await ethers.getContractFactory("LootboxKey");
  const lootboxKey = await LootboxKey.connect(deployer).deploy("");
  await lootboxKey.waitForDeployment();

  // Deploy mixer
  const Mixer = await ethers.getContractFactory("Mixer");
  const mixer = await Mixer.connect(deployer).deploy();
  await mixer.waitForDeployment();

  // Allow mixer to mint lootbox keys
  await (await lootboxKey.grantRole(await lootboxKey.MINTER_ROLE(), await mixer.getAddress())).wait();

  // Test recipe: 1 input key (any id 1..8) => 1 lootbox key id=1; escrow into mixer (so we can withdraw if needed)
  await (
    await mixer.setRecipe(1, {
      tokenType: 0,
      inputToken: await inputKeys.getAddress(),
      minId: 1,
      maxId: 8,
      requiredTotal: 1,
      mode: 0,
      consumeTo: await mixer.getAddress(),
      outputKey: await lootboxKey.getAddress(),
      outputKeyId: 1,
      outputAmount: 1,
      enabled: true
    })
  ).wait();

  // Deploy mock rewards
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const somi = await MockERC20.connect(deployer).deploy("SOMI", "SOMI");
  await somi.waitForDeployment();

  const MockERC721 = await ethers.getContractFactory("MockERC721");
  const quills = await MockERC721.connect(deployer).deploy("Quills", "QUILLS");
  await quills.waitForDeployment();

  // Deploy lootbox (keys = lootboxKey)
  const Lootbox = await ethers.getContractFactory("Lootbox");
  const lootbox = await Lootbox.connect(deployer).deploy(await lootboxKey.getAddress(), rng.address);
  await lootbox.waitForDeployment();

  // Allow lootbox to mint NFTs on claim
  await (await quills.transferOwnership(await lootbox.getAddress())).wait();

  // Configure 5 rewards, 20% each (weight=2000, total=10000)
  const W = 2000;
  await (
    await lootbox.setPrize(0, W, 5, 2, await quills.getAddress(), 0, 1) // ERC721
  ).wait();
  await (
    await lootbox.setPrize(1, W, 100, 1, await somi.getAddress(), 0, ethers.parseEther("100"))
  ).wait();
  await (
    await lootbox.setPrize(2, W, 100, 1, await somi.getAddress(), 0, ethers.parseEther("10000"))
  ).wait();
  await (
    await lootbox.setPrize(3, W, 100, 3, ethers.ZeroAddress, 0, 100) // points
  ).wait();
  await (
    await lootbox.setPrize(4, W, 100, 4, ethers.ZeroAddress, 0, 1) // whitelist
  ).wait();
  await (await lootbox.lockConfig()).wait();

  // Fund ERC20 pool for claims
  await (await somi.mint(await lootbox.getAddress(), ethers.parseEther("100000000"))).wait();

  console.log(
    JSON.stringify(
      {
        inputKeys: await inputKeys.getAddress(),
        mixer: await mixer.getAddress(),
        lootboxKey: await lootboxKey.getAddress(),
        lootbox: await lootbox.getAddress(),
        somi: await somi.getAddress(),
        quills: await quills.getAddress()
      },
      null,
      2
    )
  );

  // Approvals
  await (await inputKeys.connect(user).setApprovalForAll(await mixer.getAddress(), true)).wait();
  await (await lootboxKey.connect(user).setApprovalForAll(await lootbox.getAddress(), true)).wait();

  // EIP712 mint helper for Keys1155
  const network = await ethers.provider.getNetwork();
  const domain = {
    name: "SomniaKeys",
    version: "1",
    chainId: Number(network.chainId),
    verifyingContract: await inputKeys.getAddress()
  };
  const types = {
    Mint: [
      { name: "to", type: "address" },
      { name: "id", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" }
    ]
  };

  let nonce = 1;
  const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;

  async function mintInputKey(id) {
    const value = { to: user.address, id, nonce, deadline };
    const sig = await deployer.signTypedData(domain, types, value);
    await (await inputKeys.mintWithSig(user.address, id, nonce, deadline, sig)).wait();
    nonce++;
  }

  function randomnessForItemType(itemType) {
    // totalWeight=10000, bucket size=2000
    return BigInt(itemType * 2000);
  }

  async function openOnceForce(itemType) {
    // 1) mint 1 input key (any allowed id)
    await mintInputKey(1);

    // 2) mix 1 -> 1 lootboxKey
    await (await mixer.connect(user).mixERC1155(1, [1], [1])).wait();

    // 3) open lootbox (burns 1 lootboxKey)
    const openTx = await lootbox.connect(user).openWithKey(1);
    const openRc = await openTx.wait();
    const openEv = decodeReceiptEvents(openRc, lootbox.interface).find((e) => e.name === "OpenRequested");
    const requestId = openEv.args.requestId;

    // 4) fulfill randomness forcing bucket
    const fulfillTx = await lootbox.connect(rng).fulfillRandomness(requestId, randomnessForItemType(itemType));
    const fulfillRc = await fulfillTx.wait();
    const awardEv = decodeReceiptEvents(fulfillRc, lootbox.interface).find((e) => e.name === "ItemAwarded");

    console.log("Awarded itemType=", Number(awardEv.args.itemType));

    // 5) claim if needed
    if (Number(awardEv.args.itemType) === 0) {
      await (await lootbox.connect(user).claimErc721(await quills.getAddress(), 1)).wait();
    }
    if (Number(awardEv.args.itemType) === 1 || Number(awardEv.args.itemType) === 2) {
      await (await lootbox.connect(user).claimErc20(await somi.getAddress())).wait();
    }
  }

  // Force all 5 rewards once
  for (let t = 0; t < 5; t++) {
    await openOnceForce(t);
  }

  console.log("Final balances:");
  console.log("SOMI:", (await somi.balanceOf(user.address)).toString());
  console.log("QuillsNFT:", (await quills.balanceOf(user.address)).toString());
  console.log("LootboxKey(id=1):", (await lootboxKey.balanceOf(user.address, 1)).toString());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});


