import hre from "hardhat";
const { ethers } = hre;

// Local mechanics test:
// 1) Deploy Keys1155 (EIP712 mintWithSig), Mixer, LootboxKey, instant Lootbox, mock reward tokens
// 2) Mint input keys, mix into lootbox key, open lootbox (award in same tx)
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

  const [deployer, user] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("User:", user.address);

  const Keys1155 = await ethers.getContractFactory("Keys1155");
  const inputKeys = await Keys1155.connect(deployer).deploy("ipfs://base/", deployer.address);
  await inputKeys.waitForDeployment();

  const LootboxKey = await ethers.getContractFactory("LootboxKey");
  const lootboxKey = await LootboxKey.connect(deployer).deploy("");
  await lootboxKey.waitForDeployment();

  const Mixer = await ethers.getContractFactory("Mixer");
  const mixer = await Mixer.connect(deployer).deploy();
  await mixer.waitForDeployment();

  await (await lootboxKey.grantRole(await lootboxKey.MINTER_ROLE(), await mixer.getAddress())).wait();

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

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const somi = await MockERC20.connect(deployer).deploy("SOMI", "SOMI");
  await somi.waitForDeployment();

  const MockERC721 = await ethers.getContractFactory("MockERC721");
  const quills = await MockERC721.connect(deployer).deploy("Quills", "QUILLS");
  await quills.waitForDeployment();

  const Lootbox = await ethers.getContractFactory("Lootbox");
  const lootbox = await Lootbox.connect(deployer).deploy(await lootboxKey.getAddress(), 0);
  await lootbox.waitForDeployment();

  await (await quills.transferOwnership(await lootbox.getAddress())).wait();

  const mass = 2000;
  await (await lootbox.setPrize(0, mass, 4, await quills.getAddress(), 0, 1)).wait();
  await (await lootbox.setPrize(1, mass, 1, await somi.getAddress(), 0, ethers.parseEther("100"))).wait();
  await (await lootbox.setPrize(2, mass, 1, await somi.getAddress(), 0, ethers.parseEther("10000"))).wait();
  await (await lootbox.setPrize(3, mass, 3, ethers.ZeroAddress, 0, 100)).wait();
  await (await lootbox.setPrize(4, mass, 5, ethers.ZeroAddress, 0, 1)).wait();
  await (await lootbox.setPrize(5, 0, 0, ethers.ZeroAddress, 0, 0)).wait();
  await (await lootbox.setPrize(6, 0, 0, ethers.ZeroAddress, 0, 0)).wait();
  await (await lootbox.lockConfig()).wait();

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

  await (await inputKeys.connect(user).setApprovalForAll(await mixer.getAddress(), true)).wait();
  await (await lootboxKey.connect(user).setApprovalForAll(await lootbox.getAddress(), true)).wait();

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

  await mintInputKey(1);
  await (await mixer.connect(user).mixERC1155(1, [1], [1])).wait();

  const openTx = await lootbox.connect(user).openWithKey(1);
  const openRc = await openTx.wait();
  const decoded = decodeReceiptEvents(openRc, lootbox.interface);
  const awardEv = decoded.find((e) => e.name === "ItemAwarded");
  console.log("Awarded itemType=", Number(awardEv.args.itemType));

  const it = Number(awardEv.args.itemType);
  if (it === 0) {
    await (await lootbox.connect(user).claimErc721(await quills.getAddress(), 1)).wait();
  }
  if (it === 1 || it === 2) {
    await (await lootbox.connect(user).claimErc20(await somi.getAddress())).wait();
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
