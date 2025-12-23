import { expect } from "chai";
import { ethers } from "hardhat";
import { expectRevert } from "./helpers.js";

// Odyssey requirement: 100 of any ids in [1..8]

describe("Mixer", function () {
  async function deployFixture() {
    const [deployer, user] = await ethers.getSigners();

    const Keys = await ethers.getContractFactory("MockERC1155Keys");
    const odysseyKeys = await Keys.deploy();

    const LootboxKey = await ethers.getContractFactory("LootboxKey");
    const lootboxKey = await LootboxKey.deploy("");

    const Mixer = await ethers.getContractFactory("Mixer");
    const mixer = await Mixer.deploy();

    // Grant mixer mint role
    await lootboxKey.grantRole(await lootboxKey.MINTER_ROLE(), await mixer.getAddress());

    // Recipe 1: ERC1155 odyssey keys [1..8], require 100 total, escrow, mint lootboxKey id=1 amount=1
    await mixer.setRecipe(1, {
      tokenType: 0,
      inputToken: await odysseyKeys.getAddress(),
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

    // Mint odyssey keys to user: 60 of id1 + 40 of id7
    await odysseyKeys.mint(user.address, 1, 60);
    await odysseyKeys.mint(user.address, 7, 40);
    await odysseyKeys.connect(user).setApprovalForAll(await mixer.getAddress(), true);

    return { deployer, user, odysseyKeys, lootboxKey, mixer };
  }

  it("mixes 100 keys across ids 1..8 into 1 lootbox key", async function () {
    const { user, odysseyKeys, lootboxKey, mixer } = await deployFixture();

    const before1 = await odysseyKeys.balanceOf(user.address, 1);
    const before7 = await odysseyKeys.balanceOf(user.address, 7);

    const tx = await mixer.connect(user).mixERC1155(1, [1, 7], [60, 40]);
    const receipt = await tx.wait();
    const decoded = receipt.logs
      .map((log) => {
        try {
          return mixer.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const ev = decoded.find((e) => e.name === "Mixed");
    expect(ev.args.recipeId).to.equal(1);
    expect(ev.args.user).to.equal(user.address);
    expect(ev.args.inputToken).to.equal(await odysseyKeys.getAddress());
    expect(ev.args.requiredTotal).to.equal(100);
    expect(ev.args.outputKey).to.equal(await lootboxKey.getAddress());
    expect(ev.args.outputKeyId).to.equal(1);
    expect(ev.args.outputAmount).to.equal(1);

    const after1 = await odysseyKeys.balanceOf(user.address, 1);
    const after7 = await odysseyKeys.balanceOf(user.address, 7);

    // Escrow mode transfers tokens to consumeTo (mixer in this test)
    expect(after1).to.equal(before1 - 60n);
    expect(after7).to.equal(before7 - 40n);

    // User receives lootbox key
    expect(await lootboxKey.balanceOf(user.address, 1)).to.equal(1);

    // consumeTo (mixer) holds escrowed inputs
    expect(await odysseyKeys.balanceOf(await mixer.getAddress(), 1)).to.equal(60);
    expect(await odysseyKeys.balanceOf(await mixer.getAddress(), 7)).to.equal(40);
  });

  it("rejects ids out of allowed range", async function () {
    const { user, mixer } = await deployFixture();
    await expectRevert(mixer.connect(user).mixERC1155(1, [9], [100]), "BadInput");
  });

  it("rejects wrong total", async function () {
    const { user, mixer } = await deployFixture();
    await expectRevert(mixer.connect(user).mixERC1155(1, [1], [99]), "BadInput");
  });

  it("can freeze recipe to prevent changes", async function () {
    const { mixer, odysseyKeys, lootboxKey } = await deployFixture();
    await mixer.freezeRecipe(1);
    await expectRevert(
      mixer.setRecipe(1, {
        tokenType: 0,
        inputToken: await odysseyKeys.getAddress(),
        minId: 1,
        maxId: 8,
        requiredTotal: 100,
        mode: 0,
        consumeTo: await mixer.getAddress(),
        outputKey: await lootboxKey.getAddress(),
        outputKeyId: 1,
        outputAmount: 1,
        enabled: true
      }),
      "RecipeFrozenErr"
    );
  });

  it("burn mode burns inputs (no escrow) if token supports burnBatch", async function () {
    const [deployer, user] = await ethers.getSigners();

    const Keys = await ethers.getContractFactory("MockERC1155Keys");
    const odysseyKeys = await Keys.deploy();

    const LootboxKey = await ethers.getContractFactory("LootboxKey");
    const lootboxKey = await LootboxKey.deploy("");

    const Mixer = await ethers.getContractFactory("Mixer");
    const mixer = await Mixer.deploy();

    await lootboxKey.grantRole(await lootboxKey.MINTER_ROLE(), await mixer.getAddress());

    await mixer.setRecipe(2, {
      tokenType: 0,
      inputToken: await odysseyKeys.getAddress(),
      minId: 1,
      maxId: 8,
      requiredTotal: 100,
      mode: 1, // BURN
      consumeTo: ethers.ZeroAddress,
      outputKey: await lootboxKey.getAddress(),
      outputKeyId: 1,
      outputAmount: 1,
      enabled: true
    });

    await odysseyKeys.mint(user.address, 2, 100);
    await odysseyKeys.connect(user).setApprovalForAll(await mixer.getAddress(), true);

    const before = await odysseyKeys.balanceOf(user.address, 2);
    await mixer.connect(user).mixERC1155(2, [2], [100]);
    const after = await odysseyKeys.balanceOf(user.address, 2);
    expect(after).to.equal(before - 100n);

    // Since burn mode, mixer/sink should not receive the inputs
    expect(await odysseyKeys.balanceOf(await mixer.getAddress(), 2)).to.equal(0);
  });
});


