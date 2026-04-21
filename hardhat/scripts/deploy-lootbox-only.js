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

async function main() {
  loadRootEnvLocal();
  if (!process.env.SOMNIA_RPC_URL && process.env.NEXT_PUBLIC_RPC_URL) {
    process.env.SOMNIA_RPC_URL = process.env.NEXT_PUBLIC_RPC_URL;
  }
  mustEnv("SOMNIA_RPC_URL");
  mustEnv("DEPLOYER_PRIVATE_KEY");
  if (hre.network.name !== "somnia") throw new Error("Run with --network somnia");

  const lootboxKeyAddress = mustEnv("LOOTBOX_KEY_ADDRESS");
  const maxPerUser = Number.parseInt(process.env.MAX_OPENS_PER_USER || "2", 10);
  if (!Number.isFinite(maxPerUser) || maxPerUser < 0) throw new Error("Bad MAX_OPENS_PER_USER");

  const [signer] = await ethers.getSigners();
  const Lootbox = await ethers.getContractFactory("Lootbox");
  const lootbox = await Lootbox.deploy(lootboxKeyAddress, maxPerUser);
  await lootbox.waitForDeployment();

  console.log(
    JSON.stringify(
      {
        network: hre.network.name,
        deployer: signer.address,
        lootbox: await lootbox.getAddress(),
        lootboxKey: lootboxKeyAddress,
        maxOpensPerUser: maxPerUser
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

