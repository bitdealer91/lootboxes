import { expect } from "chai";
import hre from "hardhat";

const { ethers } = hre;
import { decodeReceiptEvents } from "./helpers.js";

// End-to-end: Keys1155 -> Mixer (100 input keys) -> LootboxKey -> instant Lootbox (openWithKey awards in same tx).

describe("Full flow: Keys1155 -> Mixer -> LootboxKey -> Lootbox", function () {
  async function deployFixture() {
    const [deployer, user, sigSigner] = await ethers.getSigners();

    const Keys1155 = await ethers.getContractFactory("Keys1155");
    const inputKeys = await Keys1155.deploy("ipfs://base/", sigSigner.address);

    const LootboxKey = await ethers.getContractFactory("LootboxKey");
    const lootboxKey = await LootboxKey.deploy("");

    const Mixer = await ethers.getContractFactory("Mixer");
    const mixer = await Mixer.deploy();

    await lootboxKey.grantRole(await lootboxKey.MINTER_ROLE(), await mixer.getAddress());

    await mixer.setRecipe(1, {
      tokenType: 0,
      inputToken: await inputKeys.getAddress(),
      minId: 1,
      maxId: 8,
      requiredTotal: 100,
      mode: 0,
      consumeTo: await mixer.getAddress(),
      outputKey: await lootboxKey.getAddress(),
      outputKeyId: 1,
      outputAmount: 1,
      enabled: true
    });

    const E20 = await ethers.getContractFactory("MockERC20");
    const somi = await E20.deploy("SOMI", "SOMI");

    const E721 = await ethers.getContractFactory("MockERC721");
    const quills = await E721.deploy("Quills", "QUILLS");

    const Lootbox = await ethers.getContractFactory("Lootbox");
    const lootbox = await Lootbox.deploy(await lootboxKey.getAddress(), 0);

    await quills.transferOwnership(await lootbox.getAddress());

    const mass = 2000;
    await lootbox.setPrize(0, mass, 4, await quills.getAddress(), 0, 1);
    await lootbox.setPrize(1, mass, 1, await somi.getAddress(), 0, ethers.parseEther("100"));
    await lootbox.setPrize(2, mass, 1, await somi.getAddress(), 0, ethers.parseEther("10000"));
    await lootbox.setPrize(3, mass, 3, ethers.ZeroAddress, 0, 100);
    await lootbox.setPrize(4, mass, 5, ethers.ZeroAddress, 0, 1);
    await lootbox.setPrize(5, 0, 0, ethers.ZeroAddress, 0, 0);
    await lootbox.setPrize(6, 0, 0, ethers.ZeroAddress, 0, 0);

    await lootbox.lockConfig();

    await somi.mint(await lootbox.getAddress(), ethers.parseEther("99999999"));

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

    return { deployer, user, sigSigner, inputKeys, mixer, lootboxKey, lootbox, somi, quills, domain, types };
  }

  it("mints inputs with signatures, mixes 100 -> 1 lootboxKey, then opens (instant award)", async function () {
    const { user, sigSigner, inputKeys, mixer, lootboxKey, lootbox, somi, quills, domain, types } = await deployFixture();

    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;

    let nonce = 1;
    const mintOne = async (id) => {
      const value = { to: user.address, id, nonce, deadline };
      const sig = await sigSigner.signTypedData(domain, types, value);
      await inputKeys.mintWithSig(user.address, id, nonce, deadline, sig);
      nonce++;
    };

    for (let i = 0; i < 30; i++) await mintOne(1);
    for (let i = 0; i < 20; i++) await mintOne(2);
    for (let i = 0; i < 50; i++) await mintOne(8);

    await inputKeys.connect(user).setApprovalForAll(await mixer.getAddress(), true);

    await mixer.connect(user).mixERC1155(1, [1, 2, 8], [30, 20, 50]);
    expect(await lootboxKey.balanceOf(user.address, 1)).to.equal(1n);

    await lootboxKey.connect(user).setApprovalForAll(await lootbox.getAddress(), true);

    const openTx = await lootbox.connect(user).openWithKey(1);
    const openRc = await openTx.wait();
    const decoded = decodeReceiptEvents(openRc, lootbox.interface);
    expect(decoded.some((e) => e.name === "OpenRequested")).to.equal(true);
    const awardEv = decoded.find((e) => e.name === "ItemAwarded");
    expect(awardEv).to.not.equal(undefined);
    expect(awardEv.args.user).to.equal(user.address);

    const it = Number(awardEv.args.itemType);
    expect(it).to.be.oneOf([0, 1, 2, 3, 4]);

    if (it === 1 || it === 2) {
      await lootbox.connect(user).claimErc20(await somi.getAddress());
    } else if (it === 0) {
      await lootbox.connect(user).claimErc721(await quills.getAddress(), 1);
    }
  });
});
