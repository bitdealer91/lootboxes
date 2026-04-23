import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { config as dotenvConfig } from "dotenv";
import hre from "hardhat";

const { ethers } = hre;

function loadRootEnvLocal() {
  const rootEnvPath = path.resolve(process.cwd(), "../.env.local");
  if (fs.existsSync(rootEnvPath)) dotenvConfig({ path: rootEnvPath, override: false });
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

  const inputToken = mustEnv("INPUT_TOKEN");
  const consumeTo = mustEnv("CONSUME_TO");
  const requiredTotal = BigInt(process.env.REQUIRED_TOTAL || "8");
  const recipeId = BigInt(process.env.RECIPE_ID || "1");
  const maxOpensPerUser = Number.parseInt(process.env.MAX_OPENS_PER_USER || "2", 10);

  const [deployer] = await ethers.getSigners();
  console.log("Network:", hre.network.name);
  console.log("Deployer:", deployer.address);

  const Key = await ethers.getContractFactory("LootboxKeyNoCap");
  const key = await Key.deploy("");
  await key.waitForDeployment();

  const Mixer = await ethers.getContractFactory("Mixer");
  const mixer = await Mixer.deploy();
  await mixer.waitForDeployment();

  let tx = await key.grantRole(await key.MINTER_ROLE(), await mixer.getAddress());
  await tx.wait();
  tx = await key.setMixer(await mixer.getAddress());
  await tx.wait();

  tx = await mixer.setRecipe(recipeId, {
    tokenType: 0,
    inputToken,
    minId: 1,
    maxId: 8,
    requiredTotal,
    mode: 0, // ESCROW
    consumeTo,
    outputKey: await key.getAddress(),
    outputKeyId: 1,
    outputAmount: 1,
    enabled: true
  });
  await tx.wait();
  tx = await mixer.freezeRecipe(recipeId);
  await tx.wait();

  const Lootbox = await ethers.getContractFactory("Lootbox");
  const lootbox = await Lootbox.deploy(await key.getAddress(), maxOpensPerUser);
  await lootbox.waitForDeployment();

  console.log(
    JSON.stringify(
      {
        key: await key.getAddress(),
        mixer: await mixer.getAddress(),
        lootbox: await lootbox.getAddress(),
        recipeId: Number(recipeId),
        requiredTotal: requiredTotal.toString(),
        consumeTo,
        maxOpensPerUser
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

