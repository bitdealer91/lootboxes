import { expect } from "chai";
import { ethers } from "hardhat";
import { decodeReceiptEvents } from "./helpers.js";

// End-to-end local flow:
// Keys1155 (id 1..8, mintWithSig) -> Mixer (100 any ids) -> LootboxKey (id=1) -> Lootbox openWithKey(1)
// Config: 5 prizes, equal 20% each.

describe("Full flow: Keys1155 -> Mixer -> LootboxKey -> Lootbox", function () {
  function bucketStart(itemType) {
    // totalWeight=10000, each bucket=2000
    return BigInt(itemType * 2000);
  }

  async function deployFixture() {
    const [deployer, user, sigSigner, rng] = await ethers.getSigners();

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
    const lootbox = await Lootbox.deploy(await lootboxKey.getAddress(), rng.address);

    // allow lootbox to mint NFTs on claim
    await quills.transferOwnership(await lootbox.getAddress());

    // equal weights (20% each) => 2000 each, total 10000
    const W = 2000;

    await lootbox.setPrize(0, W, 50, 2, await quills.getAddress(), 0, 1);
    await lootbox.setPrize(1, W, 500, 1, await somi.getAddress(), 0, ethers.parseEther("100"));
    await lootbox.setPrize(2, W, 500, 1, await somi.getAddress(), 0, ethers.parseEther("10000"));
    await lootbox.setPrize(3, W, 500, 3, ethers.ZeroAddress, 0, 100);
    await lootbox.setPrize(4, W, 500, 4, ethers.ZeroAddress, 0, 1);

    await lootbox.lockConfig();

    // fund ERC20 pool
    await somi.mint(await lootbox.getAddress(), ethers.parseEther("99999999"));

    // Prepare EIP712 minting
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

    return { deployer, user, sigSigner, rng, inputKeys, mixer, lootboxKey, lootbox, somi, quills, domain, types };
  }

  it("mints inputs with signatures, mixes 100 -> 1 lootboxKey, then opens and forces each reward deterministically", async function () {
    const { user, sigSigner, rng, inputKeys, mixer, lootboxKey, lootbox, somi, quills, domain, types } = await deployFixture();

    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;

    // Mint 100 input keys: 30 id1 + 20 id2 + 50 id8
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

    // Mix into lootbox key
    await mixer.connect(user).mixERC1155(1, [1, 2, 8], [30, 20, 50]);
    expect(await lootboxKey.balanceOf(user.address, 1)).to.equal(1);

    // Approve lootbox to burn lootboxKey
    await lootboxKey.connect(user).setApprovalForAll(await lootbox.getAddress(), true);

    // Open once and fulfill reward itemType=2 (for example)
    const openTx = await lootbox.connect(user).openWithKey(1);
    const openRc = await openTx.wait();
    const openEv = decodeReceiptEvents(openRc, lootbox.interface).find((e) => e.name === "OpenRequested");
    const requestId = openEv.args.requestId;

    // Force itemType=2 by providing randomness that falls into bucket start 4000
    const fulfillTx = await lootbox.connect(rng).fulfillRandomness(requestId, bucketStart(2));
    const fulfillRc = await fulfillTx.wait();
    const awardEv = decodeReceiptEvents(fulfillRc, lootbox.interface).find((e) => e.name === "ItemAwarded");
    expect(awardEv.args.user).to.equal(user.address);
    expect(Number(awardEv.args.itemType)).to.equal(2);

    // Claim ERC20
    const somiBefore = await somi.balanceOf(user.address);
    await lootbox.connect(user).claimErc20(await somi.getAddress());
    const somiAfter = await somi.balanceOf(user.address);
    expect(somiAfter).to.be.gt(somiBefore);

    // Now mint MORE input keys, make MORE lootboxKeys, and guarantee that Quills (itemType 0) is awarded
    // by forcing randomness bucket 0.

    // mint 100 more input keys (all id1)
    for (let i = 0; i < 100; i++) await mintOne(1);
    await mixer.connect(user).mixERC1155(1, [1], [100]);
    expect(await lootboxKey.balanceOf(user.address, 1)).to.equal(1); // spent 1 already, got 1 new

    const openTx2 = await lootbox.connect(user).openWithKey(1);
    const openRc2 = await openTx2.wait();
    const openEv2 = decodeReceiptEvents(openRc2, lootbox.interface).find((e) => e.name === "OpenRequested");
    const requestId2 = openEv2.args.requestId;

    const fulfillTx2 = await lootbox.connect(rng).fulfillRandomness(requestId2, bucketStart(0));
    await fulfillTx2.wait();

    // Claim NFT
    const nftBefore = await quills.balanceOf(user.address);
    await lootbox.connect(user).claimErc721(await quills.getAddress(), 1);
    const nftAfter = await quills.balanceOf(user.address);
    expect(nftAfter - nftBefore).to.equal(1n);
  });
});


