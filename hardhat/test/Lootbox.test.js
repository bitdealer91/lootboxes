import { expect } from "chai";
import { ethers } from "hardhat";
import { decodeReceiptEvents, expectRevert } from "./helpers.js";

const WEIGHTS = {
  quills: 2000,
  somi100: 4000,
  somi10000: 2000,
  points: 1000,
  whitelist: 1000
};

function rForBucketStart(bucketStart) {
  // because r = randomness % totalWeight
  return BigInt(bucketStart);
}

describe("Lootbox", function () {
  async function deployFixture() {
    const [deployer, user, rng] = await ethers.getSigners();

    const Keys = await ethers.getContractFactory("MockERC1155Keys");
    const keys = await Keys.deploy();

    const E20 = await ethers.getContractFactory("MockERC20");
    const somi = await E20.deploy("SOMI", "SOMI");

    const E721 = await ethers.getContractFactory("MockERC721");
    const quills = await E721.deploy("Quills", "QUILLS");

    const Lootbox = await ethers.getContractFactory("Lootbox");
    const lootbox = await Lootbox.deploy(await keys.getAddress(), rng.address);

    // Let the lootbox mint NFTs on claim.
    await quills.transferOwnership(await lootbox.getAddress());

    // Configure prizes
    // itemType 0: Quills NFT (ERC721), qty 5
    await lootbox.setPrize(0, WEIGHTS.quills, 5, 2, await quills.getAddress(), 0, 1);
    // itemType 1: 100 SOMI (ERC20), qty 100
    await lootbox.setPrize(1, WEIGHTS.somi100, 100, 1, await somi.getAddress(), 0, ethers.parseEther("100"));
    // itemType 2: 10000 SOMI (ERC20), qty 1000
    await lootbox.setPrize(2, WEIGHTS.somi10000, 1000, 1, await somi.getAddress(), 0, ethers.parseEther("10000"));
    // itemType 3: 100 Points (POINTS), qty 100
    await lootbox.setPrize(3, WEIGHTS.points, 100, 3, ethers.ZeroAddress, 0, 100);
    // itemType 4: Whitelist (WHITELIST), qty 10
    await lootbox.setPrize(4, WEIGHTS.whitelist, 10, 4, ethers.ZeroAddress, 0, 1);

    await lootbox.lockConfig();

    // Fund lootbox with SOMI for ERC20 prizes (used on claim)
    await somi.mint(await lootbox.getAddress(), ethers.parseEther("2000000"));

    // Mint keys: give user a bunch of keys of id=1
    await keys.mint(user.address, 1, 5000);

    // Approve lootbox to burn keys
    await keys.connect(user).setApprovalForAll(await lootbox.getAddress(), true);

    return { deployer, user, rng, keys, somi, quills, lootbox };
  }

  it("burns exactly 1 key and emits OpenRequested", async function () {
    const { user, keys, lootbox } = await deployFixture();

    const before = await keys.balanceOf(user.address, 1);
    const tx = await lootbox.connect(user).openWithKey(1);
    const receipt = await tx.wait();

    const after = await keys.balanceOf(user.address, 1);
    expect(after).to.equal(before - 1n);

    const decoded = decodeReceiptEvents(receipt, lootbox.interface);
    const ev = decoded.find((e) => e.name === "OpenRequested");
    expect(ev).to.not.equal(undefined);
  });

  it("prevents parallel opens per user (PendingRequest)", async function () {
    const { user, lootbox } = await deployFixture();

    await lootbox.connect(user).openWithKey(1);
    await expectRevert(lootbox.connect(user).openWithKey(1), "PendingRequest");
  });

  it("deterministically can award each prize bucket via fulfillRandomness", async function () {
    const { user, rng, lootbox, quills, somi } = await deployFixture();

    // Bucket boundaries with totalWeight=10000
    const starts = {
      item0: 0,
      item1: WEIGHTS.quills,
      item2: WEIGHTS.quills + WEIGHTS.somi100,
      item3: WEIGHTS.quills + WEIGHTS.somi100 + WEIGHTS.somi10000,
      item4: WEIGHTS.quills + WEIGHTS.somi100 + WEIGHTS.somi10000 + WEIGHTS.points
    };

    async function openAndFulfill(r) {
      const tx = await lootbox.connect(user).openWithKey(1);
      const receipt = await tx.wait();
      const decoded = decodeReceiptEvents(receipt, lootbox.interface);
      const req = decoded.find((e) => e.name === "OpenRequested");
      const requestId = req.args.requestId;
      return lootbox.connect(rng).fulfillRandomness(requestId, r);
    }

    // 0) Quills (ERC721)
    const tx0 = await openAndFulfill(rForBucketStart(starts.item0));
    const rc0 = await tx0.wait();
    const ev0 = decodeReceiptEvents(rc0, lootbox.interface).find((e) => e.name === "ItemAwarded");
    expect(ev0.args.user).to.equal(user.address);
    expect(ev0.args.itemType).to.equal(0);
    expect(await lootbox.claimableErc721(user.address, await quills.getAddress())).to.equal(1);
    const nftBalBefore = await quills.balanceOf(user.address);
    await lootbox.connect(user).claimErc721(await quills.getAddress(), 1);
    const nftBalAfter = await quills.balanceOf(user.address);
    expect(nftBalAfter - nftBalBefore).to.equal(1n);

    // 1) 100 SOMI
    const somiBefore = await somi.balanceOf(user.address);
    const tx1 = await openAndFulfill(rForBucketStart(starts.item1));
    const rc1 = await tx1.wait();
    const ev1 = decodeReceiptEvents(rc1, lootbox.interface).find((e) => e.name === "ItemAwarded");
    expect(ev1.args.user).to.equal(user.address);
    expect(ev1.args.itemType).to.equal(1);
    expect(ev1.args.token).to.equal(await somi.getAddress());
    expect(ev1.args.amount).to.equal(ethers.parseEther("100"));
    expect(await lootbox.claimableErc20(user.address, await somi.getAddress())).to.equal(ethers.parseEther("100"));
    await lootbox.connect(user).claimErc20(await somi.getAddress());
    const somiAfter = await somi.balanceOf(user.address);
    expect(somiAfter - somiBefore).to.equal(ethers.parseEther("100"));

    // 2) 10000 SOMI
    const tx2 = await openAndFulfill(rForBucketStart(starts.item2));
    const rc2 = await tx2.wait();
    const ev2 = decodeReceiptEvents(rc2, lootbox.interface).find((e) => e.name === "ItemAwarded");
    expect(ev2.args.user).to.equal(user.address);
    expect(ev2.args.itemType).to.equal(2);
    expect(ev2.args.token).to.equal(await somi.getAddress());
    expect(ev2.args.amount).to.equal(ethers.parseEther("10000"));
    await lootbox.connect(user).claimErc20(await somi.getAddress());

    // 3) points
    const tx3 = await openAndFulfill(rForBucketStart(starts.item3));
    const rc3 = await tx3.wait();
    const ev3 = decodeReceiptEvents(rc3, lootbox.interface).find((e) => e.name === "ItemAwarded");
    expect(ev3.args.user).to.equal(user.address);
    expect(ev3.args.itemType).to.equal(3);
    expect(ev3.args.amount).to.equal(100);

    // 4) whitelist
    const tx4 = await openAndFulfill(rForBucketStart(starts.item4));
    const rc4 = await tx4.wait();
    const ev4 = decodeReceiptEvents(rc4, lootbox.interface).find((e) => e.name === "ItemAwarded");
    expect(ev4.args.user).to.equal(user.address);
    expect(ev4.args.itemType).to.equal(4);
    expect(ev4.args.amount).to.equal(1);
  });

  it("never awards an out-of-stock prize (removes it from the weighted selection)", async function () {
    const { user, rng, lootbox } = await deployFixture();

    // Reconfigure to make item0 only 1 and others available.
    // Can't because config is locked in fixture; deploy a new one unlocked.
    const [deployer, _user, _rng] = await ethers.getSigners();
    const Keys = await ethers.getContractFactory("MockERC1155Keys");
    const keys = await Keys.deploy();
    const E20 = await ethers.getContractFactory("MockERC20");
    const somi = await E20.deploy("SOMI", "SOMI");
    const E721 = await ethers.getContractFactory("MockERC721");
    const quills = await E721.deploy("Quills", "QUILLS");
    const Lootbox = await ethers.getContractFactory("Lootbox");
    const lb = await Lootbox.deploy(await keys.getAddress(), _rng.address);
    await quills.transferOwnership(await lb.getAddress());

    await lb.setPrize(0, WEIGHTS.quills, 1, 2, await quills.getAddress(), 0, 1);
    await lb.setPrize(1, WEIGHTS.somi100, 10, 1, await somi.getAddress(), 0, 1);
    await lb.setPrize(2, WEIGHTS.somi10000, 10, 1, await somi.getAddress(), 0, 1);
    await lb.setPrize(3, WEIGHTS.points, 10, 3, ethers.ZeroAddress, 0, 1);
    await lb.setPrize(4, WEIGHTS.whitelist, 10, 4, ethers.ZeroAddress, 0, 1);

    await somi.mint(await lb.getAddress(), 1000000);

    await keys.mint(_user.address, 1, 100);
    await keys.connect(_user).setApprovalForAll(await lb.getAddress(), true);

    async function openAndFulfillPickItem0() {
      const tx = await lb.connect(_user).openWithKey(1);
      const receipt = await tx.wait();
      const decoded = decodeReceiptEvents(receipt, lb.interface);
      const req = decoded.find((e) => e.name === "OpenRequested");
      const requestId = req.args.requestId;
      // r=0 targets item0 while in stock
      return lb.connect(_rng).fulfillRandomness(requestId, 0);
    }

    // First time should award item0.
    const txa = await openAndFulfillPickItem0();
    const rca = await txa.wait();
    const eva = decodeReceiptEvents(rca, lb.interface).find((e) => e.name === "ItemAwarded");
    expect(eva.args.user).to.equal(_user.address);
    expect(eva.args.itemType).to.equal(0);

    // Second time, item0 is out-of-stock, so even with r=0 it must pick the first available non-empty bucket (item1).
    const txb = await openAndFulfillPickItem0();
    const rcb = await txb.wait();
    const evb = decodeReceiptEvents(rcb, lb.interface).find((e) => e.name === "ItemAwarded");
    expect(evb.args.user).to.equal(_user.address);
    expect(evb.args.itemType).to.equal(1);
  });

  it("reserves global supply so users never burn a key after sold-out", async function () {
    const [deployer, user, rng] = await ethers.getSigners();

    const Keys = await ethers.getContractFactory("MockERC1155Keys");
    const keys = await Keys.deploy();

    const Lootbox = await ethers.getContractFactory("Lootbox");
    const lb = await Lootbox.deploy(await keys.getAddress(), rng.address);

    // Only 1 total item remaining (item3), everything else 0
    await lb.setPrize(0, WEIGHTS.quills, 0, 0, ethers.ZeroAddress, 0, 0);
    await lb.setPrize(1, WEIGHTS.somi100, 0, 0, ethers.ZeroAddress, 0, 0);
    await lb.setPrize(2, WEIGHTS.somi10000, 0, 0, ethers.ZeroAddress, 0, 0);
    await lb.setPrize(3, WEIGHTS.points, 1, 3, ethers.ZeroAddress, 0, 100);
    await lb.setPrize(4, WEIGHTS.whitelist, 0, 0, ethers.ZeroAddress, 0, 0);

    await keys.mint(user.address, 1, 2);
    await keys.connect(user).setApprovalForAll(await lb.getAddress(), true);

    // First open ok
    await lb.connect(user).openWithKey(1);
    // Second open must revert SoldOut because remainingTotal was reserved on first open
    await expectRevert(lb.connect(user).openWithKey(1), "SoldOut");
  });
});



