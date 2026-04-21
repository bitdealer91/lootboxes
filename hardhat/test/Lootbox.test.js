import { expect } from "chai";
import hre from "hardhat";

const { ethers } = hre;
import { decodeReceiptEvents, expectRevert } from "./helpers.js";

describe("Lootbox (instant)", function () {
  async function deployFixture(maxOpens = 0) {
    const [deployer, user] = await ethers.getSigners();

    const Keys = await ethers.getContractFactory("MockERC1155Keys");
    const keys = await Keys.deploy();

    const E20 = await ethers.getContractFactory("MockERC20");
    const somi = await E20.deploy("SOMI", "SOMI");

    const E721 = await ethers.getContractFactory("MockERC721");
    const quills = await E721.deploy("Quills", "QUILLS");

    const Lootbox = await ethers.getContractFactory("Lootbox");
    const lootbox = await Lootbox.deploy(await keys.getAddress(), maxOpens);

    await quills.transferOwnership(await lootbox.getAddress());

    // PrizeKind: ERC721=2, ERC20=1, POINTS=3, WHITELIST=4, NONE=0, ERC721_VAULT=5
    await lootbox.setPrize(0, 5, 4, await quills.getAddress(), 0, 1);
    await lootbox.setPrize(1, 100, 1, await somi.getAddress(), 0, ethers.parseEther("100"));
    await lootbox.setPrize(2, 1000, 1, await somi.getAddress(), 0, ethers.parseEther("10000"));
    await lootbox.setPrize(3, 100, 3, ethers.ZeroAddress, 0, 100);
    await lootbox.setPrize(4, 10, 5, ethers.ZeroAddress, 0, 1);
    await lootbox.setPrize(5, 0, 0, ethers.ZeroAddress, 0, 0);
    await lootbox.setPrize(6, 0, 0, ethers.ZeroAddress, 0, 0);

    await lootbox.lockConfig();

    await somi.mint(await lootbox.getAddress(), ethers.parseEther("2000000"));

    await keys.mint(user.address, 1, 5000);
    await keys.connect(user).setApprovalForAll(await lootbox.getAddress(), true);

    return { deployer, user, keys, somi, quills, lootbox };
  }

  it("burns key and emits OpenRequested + ItemAwarded in one transaction", async function () {
    const { user, keys, lootbox } = await deployFixture();

    const before = await keys.balanceOf(user.address, 1);
    const tx = await lootbox.connect(user).openWithKey(1);
    const receipt = await tx.wait();

    const after = await keys.balanceOf(user.address, 1);
    expect(after).to.equal(before - 1n);

    const decoded = decodeReceiptEvents(receipt, lootbox.interface);
    expect(decoded.some((e) => e.name === "OpenRequested")).to.equal(true);
    const awarded = decoded.find((e) => e.name === "ItemAwarded");
    expect(awarded).to.not.equal(undefined);
    expect(awarded.args.user).to.equal(user.address);
  });

  it("allows consecutive opens (no pending state)", async function () {
    const { user, lootbox } = await deployFixture();
    await lootbox.connect(user).openWithKey(1);
    await lootbox.connect(user).openWithKey(1);
    expect(await lootbox.successfulOpens()).to.equal(2n);
  });

  it("points path emits PointsAwarded", async function () {
    const [, user] = await ethers.getSigners();
    const Keys = await ethers.getContractFactory("MockERC1155Keys");
    const keys = await Keys.deploy();
    const Lootbox = await ethers.getContractFactory("Lootbox");
    const lb = await Lootbox.deploy(await keys.getAddress(), 0);
    await lb.setPrize(0, 10, 3, ethers.ZeroAddress, 0, 50);
    for (let i = 1; i < 7; i++) {
      await lb.setPrize(i, 0, 0, ethers.ZeroAddress, 0, 0);
    }
    await lb.lockConfig();
    await keys.mint(user.address, 1, 2);
    await keys.connect(user).setApprovalForAll(await lb.getAddress(), true);

    const tx = await lb.connect(user).openWithKey(1);
    const rc = await tx.wait();
    const decoded = decodeReceiptEvents(rc, lb.interface);
    const pts = decoded.find((e) => e.name === "PointsAwarded");
    expect(pts).to.not.equal(undefined);
    expect(pts.args.amount).to.equal(50n);
    expect(await lb.points(user.address)).to.equal(50n);
  });

  it("maxSuccessfulOpensPerUser: third open by same user reverts", async function () {
    const [, user, userB] = await ethers.getSigners();
    const Keys = await ethers.getContractFactory("MockERC1155Keys");
    const keys = await Keys.deploy();
    const Lootbox = await ethers.getContractFactory("Lootbox");
    const lb = await Lootbox.deploy(await keys.getAddress(), 2n);
    await lb.setPrize(0, 100, 3, ethers.ZeroAddress, 0, 1);
    for (let i = 1; i < 7; i++) {
      await lb.setPrize(i, 0, 0, ethers.ZeroAddress, 0, 0);
    }
    await lb.lockConfig();
    await keys.mint(user.address, 1, 5);
    await keys.connect(user).setApprovalForAll(await lb.getAddress(), true);

    await lb.connect(user).openWithKey(1);
    await lb.connect(user).openWithKey(1);
    await expectRevert(lb.connect(user).openWithKey(1), "MaxOpensReached");

    // Another user has its own per-user quota.
    await keys.mint(userB.address, 1, 2);
    await keys.connect(userB).setApprovalForAll(await lb.getAddress(), true);
    await lb.connect(userB).openWithKey(1);
    await lb.connect(userB).openWithKey(1);
  });

  it("reverts open before lockConfig", async function () {
    const [deployer, user] = await ethers.getSigners();
    const Keys = await ethers.getContractFactory("MockERC1155Keys");
    const keys = await Keys.deploy();
    const Lootbox = await ethers.getContractFactory("Lootbox");
    const lb = await Lootbox.deploy(await keys.getAddress(), 0);
    await lb.setPrize(0, 10, 3, ethers.ZeroAddress, 0, 1);
    for (let i = 1; i < 7; i++) {
      await lb.setPrize(i, 0, 0, ethers.ZeroAddress, 0, 0);
    }
    await keys.mint(user.address, 1, 1);
    await keys.connect(user).setApprovalForAll(await lb.getAddress(), true);
    await expectRevert(lb.connect(user).openWithKey(1), "NotLive");
  });

  it("when only one bucket has stock, always awards that bucket", async function () {
    const [, user] = await ethers.getSigners();
    const Keys = await ethers.getContractFactory("MockERC1155Keys");
    const keys = await Keys.deploy();
    const Lootbox = await ethers.getContractFactory("Lootbox");
    const lb = await Lootbox.deploy(await keys.getAddress(), 0);

    await lb.setPrize(3, 5, 3, ethers.ZeroAddress, 0, 42);
    for (let i = 0; i < 7; i++) {
      if (i === 3) continue;
      await lb.setPrize(i, 0, 0, ethers.ZeroAddress, 0, 0);
    }
    await lb.lockConfig();
    await keys.mint(user.address, 1, 2);
    await keys.connect(user).setApprovalForAll(await lb.getAddress(), true);

    const tx = await lb.connect(user).openWithKey(1);
    const rc = await tx.wait();
    const ev = decodeReceiptEvents(rc, lb.interface).find((e) => e.name === "ItemAwarded");
    expect(Number(ev.args.itemType)).to.equal(3);
    expect(ev.args.amount).to.equal(42n);
  });

  it("sold out when no effective prizes remain", async function () {
    const [_d, user, userB] = await ethers.getSigners();
    const Keys = await ethers.getContractFactory("MockERC1155Keys");
    const keys = await Keys.deploy();
    const Lootbox = await ethers.getContractFactory("Lootbox");
    const lb = await Lootbox.deploy(await keys.getAddress(), 0);
    await lb.setPrize(0, 1, 3, ethers.ZeroAddress, 0, 100);
    for (let i = 1; i < 7; i++) {
      await lb.setPrize(i, 0, 0, ethers.ZeroAddress, 0, 0);
    }
    await lb.lockConfig();
    await keys.mint(user.address, 1, 1);
    await keys.mint(userB.address, 1, 1);
    await keys.connect(user).setApprovalForAll(await lb.getAddress(), true);
    await keys.connect(userB).setApprovalForAll(await lb.getAddress(), true);

    await lb.connect(user).openWithKey(1);
    await expectRevert(lb.connect(userB).openWithKey(1), "SoldOut");
  });

  it("ERC721_VAULT: claim dispenses from vault", async function () {
    const [deployer, user] = await ethers.getSigners();
    const Keys = await ethers.getContractFactory("MockERC1155Keys");
    const keys = await Keys.deploy();
    const E721 = await ethers.getContractFactory("MockERC721");
    const nft = await E721.deploy("Q", "Q");
    const Vault = await ethers.getContractFactory("RewardVaultERC721");
    const vault = await Vault.deploy(await nft.getAddress());

    const Lootbox = await ethers.getContractFactory("Lootbox");
    const lb = await Lootbox.deploy(await keys.getAddress(), 0);
    await vault.setLootbox(await lb.getAddress());

    await nft.mint(deployer.address);
    await nft.connect(deployer).setApprovalForAll(await vault.getAddress(), true);
    await vault.deposit([1n]);

    await lb.setPrize(0, 10, 2, await vault.getAddress(), 0, 1);
    for (let i = 1; i < 7; i++) {
      await lb.setPrize(i, 0, 0, ethers.ZeroAddress, 0, 0);
    }
    await lb.lockConfig();

    await keys.mint(user.address, 1, 1);
    await keys.connect(user).setApprovalForAll(await lb.getAddress(), true);

    await lb.connect(user).openWithKey(1);
    await lb.connect(user).claimErc721(await vault.getAddress(), 1);
    expect(await nft.ownerOf(1n)).to.equal(user.address);
  });
});
