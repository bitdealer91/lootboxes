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

  // S5 points schedule from product requirements.
  const pointSchedule = [
    { slot: 0, remaining: 26000, amount: 125 },
    { slot: 1, remaining: 22000, amount: 180 },
    { slot: 2, remaining: 16000, amount: 250 },
    { slot: 3, remaining: 14000, amount: 300 },
    { slot: 4, remaining: 10800, amount: 375 },
    { slot: 5, remaining: 8688, amount: 500 }
  ];

  const [signer] = await ethers.getSigners();
  const lootbox = await ethers.getContractAt("Lootbox", lootboxAddress, signer);

  if (await lootbox.configLocked()) {
    throw new Error("Lootbox config is locked");
  }

  console.log("Network:", hre.network.name);
  console.log("Signer:", signer.address);
  console.log("Lootbox:", lootboxAddress);
  console.log("Quills vault:", quillsVaultAddress);

  // slot 6: Quills ERC721 vault (Lootbox.PrizeKind.ERC721_VAULT = 2)
  let tx = await lootbox.setPrize(6, quillsCap, 2, quillsVaultAddress, 0, 1);
  console.log("setPrize slot6 (Quills) tx:", tx.hash);
  await tx.wait();

  for (const p of pointSchedule) {
    // Lootbox.PrizeKind.POINTS = 3
    tx = await lootbox.setPrize(p.slot, p.remaining, 3, ethers.ZeroAddress, 0, p.amount);
    console.log(`setPrize slot${p.slot} (points=${p.amount}) tx:`, tx.hash);
    await tx.wait();
  }

  // PRIZE_COUNT is 7 in Lootbox.sol (slots 0..6). No extra slots to clear.

  if (boolEnv("LOCK_CONFIG", true)) {
    tx = await lootbox.lockConfig();
    console.log("lockConfig tx:", tx.hash);
    await tx.wait();
  }

  const total = await lootbox.effectiveRemainingTotal();
  console.log("effectiveRemainingTotal:", total.toString());
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
