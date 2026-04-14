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

  const lootboxAddress = mustEnv("LOOTBOX_ADDRESS");
  const quillsVaultAddress = mustEnv("QUILLS_VAULT_ADDRESS");

  const quillsCap = Number.parseInt(process.env.QUILLS_CAP || "100", 10);
  if (!Number.isFinite(quillsCap) || quillsCap < 0 || quillsCap > 0xffffffff) {
    throw new Error("Bad QUILLS_CAP");
  }

  // Keep the previous production points schedule.
  const pointSchedule = [
    { slot: 1, remaining: 6500, amount: 500 },
    { slot: 2, remaining: 5500, amount: 750 },
    { slot: 3, remaining: 4000, amount: 1000 },
    { slot: 4, remaining: 3500, amount: 1200 },
    { slot: 5, remaining: 2700, amount: 1500 },
    { slot: 6, remaining: 2172, amount: 2000 }
  ];

  const [signer] = await ethers.getSigners();
  const lootbox = await ethers.getContractAt("TestLootboxInstant", lootboxAddress, signer);

  if (await lootbox.configLocked()) {
    throw new Error("Lootbox config is locked");
  }

  console.log("Network:", hre.network.name);
  console.log("Signer:", signer.address);
  console.log("Lootbox:", lootboxAddress);
  console.log("Quills vault:", quillsVaultAddress);

  // slot 0: Quills ERC721 vault
  let tx = await lootbox.setPrize(0, quillsCap, 2, quillsVaultAddress, 1);
  console.log("setPrize slot0 (Quills) tx:", tx.hash);
  await tx.wait();

  for (const p of pointSchedule) {
    tx = await lootbox.setPrize(p.slot, p.remaining, 3, ethers.ZeroAddress, p.amount);
    console.log(`setPrize slot${p.slot} (points=${p.amount}) tx:`, tx.hash);
    await tx.wait();
  }

  // Ensure the rest are disabled.
  for (const slot of [7, 8, 9]) {
    tx = await lootbox.setPrize(slot, 0, 0, ethers.ZeroAddress, 0);
    console.log(`setPrize slot${slot} (NONE) tx:`, tx.hash);
    await tx.wait();
  }

  if (boolEnv("LOCK_CONFIG", false)) {
    tx = await lootbox.lockConfig();
    console.log("lockConfig tx:", tx.hash);
    await tx.wait();
  }

  const total = await lootbox.remainingTotal();
  console.log("remainingTotal:", total.toString());
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
