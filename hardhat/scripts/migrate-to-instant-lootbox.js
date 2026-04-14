import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { config as dotenvConfig } from "dotenv";
import hre from "hardhat";

const { ethers } = hre;

function loadRootEnvLocal() {
  const rootEnvPath = path.resolve(process.cwd(), "../.env.local");
  if (fs.existsSync(rootEnvPath)) {
    dotenvConfig({ path: rootEnvPath, override: false });
  }
}

function mustEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function boolEnv(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  return /^(1|true|yes)$/i.test(raw);
}

function chunkArray(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function main() {
  loadRootEnvLocal();

  if (!process.env.SOMNIA_RPC_URL && process.env.NEXT_PUBLIC_RPC_URL) {
    process.env.SOMNIA_RPC_URL = process.env.NEXT_PUBLIC_RPC_URL;
  }

  mustEnv("SOMNIA_RPC_URL");
  mustEnv("DEPLOYER_PRIVATE_KEY");

  if (hre.network.name !== "somnia") {
    throw new Error("Run with --network somnia");
  }

  const oldVaultAddress = mustEnv("OLD_VAULT_ADDRESS");
  const quillsAddress = mustEnv("QUILLS_ADDRESS");
  const lootboxKeyAddress = mustEnv("LOOTBOX_KEY_ADDRESS");
  const withdrawTo = process.env.WITHDRAW_TO || "0x0bbc5d536DFFf79Db79aEa12CCA1f7bf1401bC30";

  const chunkSize = Number.parseInt(process.env.DEPOSIT_CHUNK_SIZE || "40", 10);
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) throw new Error("Bad DEPOSIT_CHUNK_SIZE");

  const autoSetPrize = boolEnv("AUTO_SET_PRIZE", true);
  const autoLockLootbox = boolEnv("AUTO_LOCK_LOOTBOX", false);
  const nftPrizeItemType = Number.parseInt(process.env.NFT_PRIZE_ITEM_TYPE || "0", 10);

  const [signer] = await ethers.getSigners();
  const signerAddr = (await signer.getAddress()).toLowerCase();

  console.log("Network:", hre.network.name);
  console.log("Signer:", signer.address);
  console.log("Old vault:", oldVaultAddress);
  console.log("Withdraw to:", withdrawTo);

  const oldVault = await ethers.getContractAt("RewardVaultERC721", oldVaultAddress, signer);
  const oldVaultOwner = (await oldVault.owner()).toLowerCase();
  if (oldVaultOwner !== signerAddr) {
    throw new Error(`Signer is not old vault owner. owner=${oldVaultOwner}, signer=${signerAddr}`);
  }

  const withdrawToLc = withdrawTo.toLowerCase();
  if (withdrawToLc !== signerAddr) {
    throw new Error(
      `Automatic re-deposit requires signer == WITHDRAW_TO. signer=${signer.address}, WITHDRAW_TO=${withdrawTo}`
    );
  }

  const leftBefore = await oldVault.remaining();
  console.log("Old vault remaining before:", leftBefore.toString());

  const withdrawnTokenIds = [];
  if (leftBefore > 0n) {
    const tx = await oldVault.withdrawRemaining(withdrawTo, 0);
    console.log("withdrawRemaining tx:", tx.hash);
    const receipt = await tx.wait();
    for (const log of receipt.logs) {
      try {
        const parsed = oldVault.interface.parseLog(log);
        if (parsed && parsed.name === "Withdrawn") {
          withdrawnTokenIds.push(parsed.args.tokenId);
        }
      } catch {
        // ignore unrelated logs
      }
    }
  }

  console.log("Withdrawn tokenIds:", withdrawnTokenIds.length);
  if (withdrawnTokenIds.length === 0) {
    console.log("No NFTs were withdrawn. Nothing to migrate.");
    return;
  }

  const RewardVault = await ethers.getContractFactory("RewardVaultERC721");
  const newVault = await RewardVault.deploy(quillsAddress);
  await newVault.waitForDeployment();
  const newVaultAddress = await newVault.getAddress();
  console.log("New vault:", newVaultAddress);

  const InstantLootbox = await ethers.getContractFactory("TestLootboxInstant");
  const newLootbox = await InstantLootbox.deploy(lootboxKeyAddress);
  await newLootbox.waitForDeployment();
  const newLootboxAddress = await newLootbox.getAddress();
  console.log("New instant lootbox:", newLootboxAddress);

  const setLbTx = await newVault.setLootbox(newLootboxAddress);
  console.log("newVault.setLootbox tx:", setLbTx.hash);
  await setLbTx.wait();

  const quills = await ethers.getContractAt(
    [
      "function isApprovedForAll(address owner, address operator) view returns (bool)",
      "function setApprovalForAll(address operator, bool approved) external"
    ],
    quillsAddress,
    signer
  );

  const isApproved = await quills.isApprovedForAll(signer.address, newVaultAddress);
  if (!isApproved) {
    const approveTx = await quills.setApprovalForAll(newVaultAddress, true);
    console.log("setApprovalForAll tx:", approveTx.hash);
    await approveTx.wait();
  } else {
    console.log("Approval already set for new vault.");
  }

  const chunks = chunkArray(withdrawnTokenIds, chunkSize);
  for (let i = 0; i < chunks.length; i++) {
    const batch = chunks[i];
    const tx = await newVault.deposit(batch);
    console.log(`deposit batch ${i + 1}/${chunks.length} tx:`, tx.hash, `count=${batch.length}`);
    await tx.wait();
  }

  if (autoSetPrize) {
    const cap = Number.parseInt(process.env.NFT_PRIZE_CAP || String(withdrawnTokenIds.length), 10);
    if (!Number.isFinite(cap) || cap < 0 || cap > 0xffffffff) throw new Error("Bad NFT_PRIZE_CAP");

    // TestLootboxInstant.PrizeKind.ERC721_VAULT = 2, amount must be 1.
    const setPrizeTx = await newLootbox.setPrize(nftPrizeItemType, cap, 2, newVaultAddress, 1);
    console.log("newLootbox.setPrize tx:", setPrizeTx.hash);
    await setPrizeTx.wait();
  }

  if (autoLockLootbox) {
    const lockTx = await newLootbox.lockConfig();
    console.log("newLootbox.lockConfig tx:", lockTx.hash);
    await lockTx.wait();
  }

  const leftAfterOld = await oldVault.remaining();
  const leftNew = await newVault.remaining();

  console.log("");
  console.log("=== Migration summary ===");
  console.log("Old vault:", oldVaultAddress);
  console.log("Old vault remaining after:", leftAfterOld.toString());
  console.log("New vault:", newVaultAddress);
  console.log("New vault remaining:", leftNew.toString());
  console.log("New instant lootbox:", newLootboxAddress);
  console.log("Migrated token count:", withdrawnTokenIds.length);
  console.log("Token IDs:", withdrawnTokenIds.map((x) => x.toString()).join(","));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
