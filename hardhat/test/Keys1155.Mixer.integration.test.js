import { expect } from "chai";
import { ethers } from "hardhat";
import { expectRevert } from "./helpers.js";

// Integration test: Keys1155 mintWithSig -> Mixer -> LootboxKey.

describe("Keys1155 + Mixer", function () {
  async function deployFixture() {
    const [deployer, user, sigSigner] = await ethers.getSigners();

    const Keys1155 = await ethers.getContractFactory("Keys1155");
    const keys = await Keys1155.deploy("ipfs://base/", sigSigner.address);

    const LootboxKey = await ethers.getContractFactory("LootboxKey");
    const lootboxKey = await LootboxKey.deploy("");

    const Mixer = await ethers.getContractFactory("Mixer");
    const mixer = await Mixer.deploy();

    await lootboxKey.grantRole(await lootboxKey.MINTER_ROLE(), await mixer.getAddress());

    // Recipe 1: 100 of any ids 1..8 => 1 lootbox key id=1
    await mixer.setRecipe(1, {
      tokenType: 0,
      inputToken: await keys.getAddress(),
      minId: 1,
      maxId: 8,
      requiredTotal: 100,
      mode: 0, // ESCROW
      consumeTo: await mixer.getAddress(),
      outputKey: await lootboxKey.getAddress(),
      outputKeyId: 1,
      outputAmount: 1,
      enabled: true
    });

    const network = await ethers.provider.getNetwork();
    const domain = {
      name: "SomniaKeys",
      version: "1",
      chainId: Number(network.chainId),
      verifyingContract: await keys.getAddress()
    };

    const types = {
      Mint: [
        { name: "to", type: "address" },
        { name: "id", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" }
      ]
    };

    return { deployer, user, sigSigner, keys, lootboxKey, mixer, domain, types };
  }

  it("mints 100 keys via signatures then mixes into 1 lootbox key", async function () {
    const { user, sigSigner, keys, lootboxKey, mixer, domain, types } = await deployFixture();

    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;

    // Mint 60 of id=1 and 40 of id=7 using unique nonces.
    let nonce = 1;
    for (let i = 0; i < 60; i++) {
      const value = { to: user.address, id: 1, nonce, deadline };
      const sig = await sigSigner.signTypedData(domain, types, value);
      await keys.mintWithSig(user.address, 1, nonce, deadline, sig);
      nonce++;
    }

    for (let i = 0; i < 40; i++) {
      const value = { to: user.address, id: 7, nonce, deadline };
      const sig = await sigSigner.signTypedData(domain, types, value);
      await keys.mintWithSig(user.address, 7, nonce, deadline, sig);
      nonce++;
    }

    expect(await keys.balanceOf(user.address, 1)).to.equal(60);
    expect(await keys.balanceOf(user.address, 7)).to.equal(40);

    await keys.connect(user).setApprovalForAll(await mixer.getAddress(), true);

    await mixer.connect(user).mixERC1155(1, [1, 7], [60, 40]);

    expect(await lootboxKey.balanceOf(user.address, 1)).to.equal(1);
  });

  it("burn-mode should fail with BurnFailed if input token has no burnBatch", async function () {
    const { user, sigSigner, keys, lootboxKey, mixer, domain, types } = await deployFixture();

    // New recipe in burn mode
    await mixer.setRecipe(2, {
      tokenType: 0,
      inputToken: await keys.getAddress(),
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

    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;

    // Mint 100 of id=2 to user.
    for (let nonce = 1; nonce <= 100; nonce++) {
      const value = { to: user.address, id: 2, nonce, deadline };
      const sig = await sigSigner.signTypedData(domain, types, value);
      await keys.mintWithSig(user.address, 2, nonce, deadline, sig);
    }

    await keys.connect(user).setApprovalForAll(await mixer.getAddress(), true);

    await expectRevert(mixer.connect(user).mixERC1155(2, [2], [100]), "BurnFailed");
  });
});


