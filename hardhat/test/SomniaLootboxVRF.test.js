import { expect } from "chai";
import hre from "hardhat";

import { expectRevert } from "./helpers.js";

const { ethers } = hre;

describe("SomniaLootboxVRF", function () {
  async function deployBase() {
    const [deployer, user, other] = await ethers.getSigners();

    const linkAddr = "0x0000000000000000000000000000000000123456";
    const mockVrf = await (
      await ethers.getContractFactory("MockVRFV2PlusWrapper")
    ).deploy(linkAddr, ethers.parseEther("0.001"));

    const lootboxKey = await (await ethers.getContractFactory("LootboxKey")).deploy("");
    const lootbox = await (
      await ethers.getContractFactory("SomniaLootboxVRF")
    ).deploy(await lootboxKey.getAddress(), await mockVrf.getAddress(), 500_000, 1, 0);

    const minterRole = await lootboxKey.MINTER_ROLE();
    await lootboxKey.grantRole(minterRole, await lootbox.getAddress());
    await lootboxKey.grantRole(minterRole, deployer.address);

    await deployer.sendTransaction({ to: await lootbox.getAddress(), value: ethers.parseEther("1") });

    return { deployer, user, other, mockVrf, lootboxKey, lootbox };
  }

  it("open + VRF: awards points (PointsAwarded is canonical on-chain total)", async function () {
    const { deployer, user, mockVrf, lootboxKey, lootbox } = await deployBase();

    await lootbox.setPrize(0, 10_000, 3, ethers.ZeroAddress, 500); // POINTS
    await lootbox.lockConfig();

    await lootboxKey.connect(deployer).mint(user.address, 1, 1);
    await lootboxKey.connect(user).setApprovalForAll(await lootbox.getAddress(), true);

    await lootbox.connect(user).openWithKey(1);
    const rid = await mockVrf.lastRequestId();
    await mockVrf.fulfill(await lootbox.getAddress(), rid, [42n]);

    expect(await lootbox.points(user.address)).to.equal(500n);

    const filter = lootbox.filters.PointsAwarded();
    const logs = await lootbox.queryFilter(filter);
    expect(logs.length).to.equal(1);
    expect(logs[0].args.newTotal).to.equal(500n);
  });

  it("open + VRF: ERC721 vault reservation and claim", async function () {
    const { deployer, user, mockVrf, lootboxKey, lootbox } = await deployBase();

    const nft = await (await ethers.getContractFactory("MockERC721")).deploy("Q", "Q");
    const vault = await (await ethers.getContractFactory("RewardVaultERC721")).deploy(await nft.getAddress());
    await vault.setLootbox(await lootbox.getAddress());

    await nft.connect(deployer).mint(deployer.address);
    await nft.connect(deployer).setApprovalForAll(await vault.getAddress(), true);
    await vault.deposit([1n]);

    await lootbox.setPrize(0, 100, 2, await vault.getAddress(), 1);
    await lootbox.lockConfig();

    await lootboxKey.connect(deployer).mint(user.address, 1, 1);
    await lootboxKey.connect(user).setApprovalForAll(await lootbox.getAddress(), true);

    await lootbox.connect(user).openWithKey(1);
    const rid = await mockVrf.lastRequestId();
    await mockVrf.fulfill(await lootbox.getAddress(), rid, [0n]);

    await lootbox.connect(user).claimErc721(await vault.getAddress(), 1);
    expect(await nft.ownerOf(1n)).to.equal(user.address);
  });

  it("VRF stuck: cannot recover before timeout; after timeout key returned; second recovery reverts", async function () {
    const { deployer, user, mockVrf, lootboxKey, lootbox } = await deployBase();

    await lootbox.setPrize(0, 100, 3, ethers.ZeroAddress, 100);
    await lootbox.lockConfig();

    await lootboxKey.connect(deployer).mint(user.address, 1, 1);
    await lootboxKey.connect(user).setApprovalForAll(await lootbox.getAddress(), true);

    await lootbox.connect(user).openWithKey(1);
    expect(await lootboxKey.balanceOf(user.address, 1)).to.equal(0n);

    const ridEarly = await mockVrf.lastRequestId();
    await expectRevert(lootbox.recoverStuckVrfRequest(ridEarly), "RecoveryTooEarly");

    const hour = 3600;
    await ethers.provider.send("evm_increaseTime", [Number(24n * BigInt(hour) + 1n)]);
    await ethers.provider.send("evm_mine");

    const rid = await mockVrf.lastRequestId();
    await lootbox.recoverStuckVrfRequest(rid);

    expect(await lootboxKey.balanceOf(user.address, 1)).to.equal(1n);
    expect(await lootbox.userHasPending(user.address)).to.equal(false);

    await expectRevert(lootbox.recoverStuckVrfRequest(rid), "RecoveryNotPending");
  });

  it("user recoverMyStuckVrfRequest after timeout", async function () {
    const { deployer, user, mockVrf, lootboxKey, lootbox } = await deployBase();

    await lootbox.setVrfRecoveryTimeoutSeconds(3600);
    await lootbox.setPrize(0, 100, 3, ethers.ZeroAddress, 50);
    await lootbox.lockConfig();

    await lootboxKey.connect(deployer).mint(user.address, 1, 1);
    await lootboxKey.connect(user).setApprovalForAll(await lootbox.getAddress(), true);
    await lootbox.connect(user).openWithKey(1);

    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine");

    await lootbox.connect(user).recoverMyStuckVrfRequest();
    expect(await lootboxKey.balanceOf(user.address, 1)).to.equal(1n);

    const rid = await mockVrf.lastRequestId();
    await expectRevert(mockVrf.fulfill(await lootbox.getAddress(), rid, [1n]), "BadRequest");
  });

  it("setPrize validation: bad configs revert", async function () {
    const { lootbox } = await deployBase();

    await expectRevert(lootbox.setPrize(0, 100, 2, ethers.ZeroAddress, 1), "BadPrizeConfig");

    await expectRevert(lootbox.setPrize(0, 100, 3, ethers.ZeroAddress, 0), "BadPrizeConfig");

    await expectRevert(
      lootbox.setPrize(0, 100, 1, "0x0000000000000000000000000000000000000001", 1),
      "Erc20PrizesDisabled"
    );

    await expectRevert(lootbox.setPrize(0, 10, 0, ethers.ZeroAddress, 0), "BadPrizeConfig");

    await lootbox.setErc20NativePrizesEnabled(true);
    await lootbox.setPrize(1, 100, 1, "0x0000000000000000000000000000000000000001", 1);
  });

  it("effectiveRemainingTotal and getPendingRequest views", async function () {
    const { deployer, user, mockVrf, lootboxKey, lootbox } = await deployBase();
    await lootbox.setPrize(0, 50, 3, ethers.ZeroAddress, 1);
    await lootbox.lockConfig();

    expect(await lootbox.effectiveRemainingTotal()).to.equal(50n);

    await lootboxKey.connect(deployer).mint(user.address, 1, 1);
    await lootboxKey.connect(user).setApprovalForAll(await lootbox.getAddress(), true);
    await lootbox.connect(user).openWithKey(1);

    const [, rid, keyId, , eligible] = await lootbox.getPendingRequest(user.address);
    expect(rid !== 0n && rid !== 0).to.equal(true);
    expect(keyId).to.equal(1n);
    expect(eligible).to.equal(false);

    await mockVrf.fulfill(await lootbox.getAddress(), rid, [0n]);
    const p2 = await lootbox.getPendingRequest(user.address);
    expect(p2[0]).to.equal(false);
  });
});

describe("RewardVaultERC721 hardening", function () {
  it("deposit open for all; lockLootbox blocks setLootbox", async function () {
    const [deployer, user] = await ethers.getSigners();
    const nft = await (await ethers.getContractFactory("MockERC721")).deploy("Q", "Q");
    const vault = await (await ethers.getContractFactory("RewardVaultERC721")).deploy(await nft.getAddress());

    await nft.connect(deployer).mint(user.address);
    await nft.connect(user).setApprovalForAll(await vault.getAddress(), true);
    await vault.connect(user).deposit([1n]);

    await nft.connect(deployer).mint(deployer.address);
    await nft.connect(deployer).setApprovalForAll(await vault.getAddress(), true);
    await vault.deposit([2n]);

    await vault.setLootbox(deployer.address);
    await vault.lockLootbox();
    await expectRevert(vault.setLootbox(user.address), "LootboxLocked");
  });
});
