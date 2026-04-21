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
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const pauseAbi = [
  "function pause() external",
  "function unpause() external",
  "function paused() view returns (bool)"
];

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

  const action = (process.env.ACTION || "pause").toLowerCase();
  if (action !== "pause" && action !== "unpause") {
    throw new Error('Set ACTION=pause or ACTION=unpause');
  }

  const mixerAddr = process.env.MIXER_ADDRESS;
  const lootboxAddr = process.env.LOOTBOX_ADDRESS;
  if (!mixerAddr && !lootboxAddr) {
    throw new Error("Set at least one of MIXER_ADDRESS, LOOTBOX_ADDRESS");
  }

  const [signer] = await ethers.getSigners();
  console.log("Signer:", signer.address);
  console.log("Action:", action);

  async function runPauseable(label, address) {
    if (!address) return;
    const c = new ethers.Contract(address, pauseAbi, signer);
    const before = await c.paused();
    console.log(`${label} (${address}) paused before:`, before);
    const tx = action === "pause" ? await c.pause() : await c.unpause();
    console.log(`${label} tx:`, tx.hash);
    await tx.wait();
    const after = await c.paused();
    console.log(`${label} paused after:`, after);
  }

  await runPauseable("Mixer", mixerAddr);
  await runPauseable("Lootbox", lootboxAddr);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
