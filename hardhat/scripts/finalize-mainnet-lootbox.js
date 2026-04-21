import hre from "hardhat";
const { ethers } = hre;

// Finalize mainnet lootbox config:
// - reads Quills vault remaining()
// - sets lootbox prize[0] remaining cap (default: 100) for Quills
// - locks config (enables opening)
//
// Run:
// LOOTBOX_ADDRESS=0x... QUILLS_VAULT_ADDRESS=0x... \
// npx hardhat run ./scripts/finalize-mainnet-lootbox.js --network somnia
//
// Optional:
// QUILLS_CAP=100
// NFT_ITEM_TYPE=6   (S5 table: Quills at itemType 6; legacy deployments used 0)

async function main() {
  await hre.run("compile");

  if (hre.network.name !== "somnia") {
    throw new Error("Run with: --network somnia");
  }

  const lootboxAddr = process.env.LOOTBOX_ADDRESS;
  const vaultAddr = process.env.QUILLS_VAULT_ADDRESS;
  if (!lootboxAddr) throw new Error("Set LOOTBOX_ADDRESS");
  if (!vaultAddr) throw new Error("Set QUILLS_VAULT_ADDRESS");

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Lootbox:", lootboxAddr);
  console.log("Vault:", vaultAddr);

  const lootbox = await ethers.getContractAt("SomniaLootboxVRF", lootboxAddr, deployer);
  const vault = await ethers.getContractAt("RewardVaultERC721", vaultAddr, deployer);

  const vaultRemaining = await vault.remaining();
  console.log("Vault remaining:", vaultRemaining.toString());

  const cap = Number.parseInt(process.env.QUILLS_CAP || "100", 10);
  if (!Number.isFinite(cap) || cap < 0) throw new Error("Bad QUILLS_CAP");

  const nftItemType = Number.parseInt(process.env.NFT_ITEM_TYPE || "6", 10);
  if (!Number.isFinite(nftItemType) || nftItemType < 0 || nftItemType > 255) throw new Error("Bad NFT_ITEM_TYPE");

  // PrizeKind.ERC721_VAULT = 2, amount=1
  // NOTE: availability is capped dynamically by vault.remaining() - reserved.
  const tx1 = await lootbox.setPrize(nftItemType, cap, 2, vaultAddr, 1);
  console.log(`Updating prize[${nftItemType}] (Quills) remaining tx:`, tx1.hash);
  await tx1.wait();

  const tx2 = await lootbox.lockConfig();
  console.log("Locking config tx:", tx2.hash);
  await tx2.wait();

  const lockVault = (process.env.LOCK_VAULT_LOOTBOX || "1").toLowerCase();
  if (lockVault === "1" || lockVault === "true" || lockVault === "yes") {
    const already = await vault.lootboxLocked();
    if (!already) {
      const tx3 = await vault.lockLootbox();
      console.log("Vault lockLootbox tx:", tx3.hash);
      await tx3.wait();
    } else {
      console.log("Vault lootbox already locked — skip.");
    }
  }

  console.log("Done. Lootbox is live.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

