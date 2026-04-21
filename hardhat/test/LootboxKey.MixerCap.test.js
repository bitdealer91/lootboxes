import { expect } from "chai";
import hre from "hardhat";

const { ethers } = hre;
import { expectRevert } from "./helpers.js";

describe("LootboxKey mixer mint cap", function () {
  it("allows at most MAX_MIXER_MINTS mints from Mixer (third mix reverts)", async function () {
    const [deployer, user] = await ethers.getSigners();

    const Keys = await ethers.getContractFactory("MockERC1155Keys");
    const odysseyKeys = await Keys.deploy();

    const LootboxKey = await ethers.getContractFactory("LootboxKey");
    const lootboxKey = await LootboxKey.deploy("");

    const Mixer = await ethers.getContractFactory("Mixer");
    const mixer = await Mixer.deploy();

    await lootboxKey.grantRole(await lootboxKey.MINTER_ROLE(), await mixer.getAddress());
    await lootboxKey.setMixer(await mixer.getAddress());

    await mixer.setRecipe(1, {
      tokenType: 0,
      inputToken: await odysseyKeys.getAddress(),
      minId: 1,
      maxId: 8,
      requiredTotal: 1,
      mode: 0,
      consumeTo: await mixer.getAddress(),
      outputKey: await lootboxKey.getAddress(),
      outputKeyId: 1,
      outputAmount: 1,
      enabled: true
    });

    await odysseyKeys.mint(user.address, 1, 10);
    await odysseyKeys.connect(user).setApprovalForAll(await mixer.getAddress(), true);

    expect(await lootboxKey.MAX_MIXER_MINTS()).to.equal(2n);

    await mixer.connect(user).mixERC1155(1, [1], [1]);
    await mixer.connect(user).mixERC1155(1, [1], [1]);
    expect(await lootboxKey.balanceOf(user.address, 1)).to.equal(2n);
    expect(await lootboxKey.mintedByMixer(1)).to.equal(2n);

    await expectRevert(mixer.connect(user).mixERC1155(1, [1], [1]), "MIXER_CAP");
  });

  it("minter that is not Mixer is not capped", async function () {
    const [deployer, user] = await ethers.getSigners();
    const LootboxKey = await ethers.getContractFactory("LootboxKey");
    const lootboxKey = await LootboxKey.deploy("");
    await lootboxKey.grantRole(await lootboxKey.MINTER_ROLE(), deployer.address);
    await lootboxKey.setMixer(ethers.ZeroAddress);
    await lootboxKey.connect(deployer).mint(user.address, 1, 5);
    expect(await lootboxKey.balanceOf(user.address, 1)).to.equal(5n);
  });
});
