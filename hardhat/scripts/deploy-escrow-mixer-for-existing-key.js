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

  if (hre.network.name !== "somnia") {
    throw new Error("Run with --network somnia");
  }

  const inputToken = mustEnv("INPUT_TOKEN");
  const lootboxKeyAddress = mustEnv("LOOTBOX_KEY_ADDRESS");
  const consumeTo = mustEnv("CONSUME_TO");
  const recipeId = BigInt(process.env.RECIPE_ID || "1");
  const requiredTotal = BigInt(process.env.REQUIRED_TOTAL || "8");
  const minId = BigInt(process.env.MIN_ID || "1");
  const maxId = BigInt(process.env.MAX_ID || "8");
  const outputKeyId = BigInt(process.env.OUTPUT_KEY_ID || "1");
  const outputAmount = BigInt(process.env.OUTPUT_AMOUNT || "1");

  const [signer] = await ethers.getSigners();
  console.log("Network:", hre.network.name);
  console.log("Signer:", signer.address);

  const Mixer = await ethers.getContractFactory("Mixer");
  const mixer = await Mixer.deploy();
  await mixer.waitForDeployment();
  const mixerAddress = await mixer.getAddress();
  console.log("New Mixer:", mixerAddress);

  const lootboxKey = await ethers.getContractAt("LootboxKey", lootboxKeyAddress, signer);
  let tx = await lootboxKey.grantRole(await lootboxKey.MINTER_ROLE(), mixerAddress);
  await tx.wait();
  console.log("Granted MINTER_ROLE to new Mixer");

  tx = await lootboxKey.setMixer(mixerAddress);
  await tx.wait();
  console.log("LootboxKey.setMixer -> new Mixer");

  tx = await mixer.setRecipe(recipeId, {
    tokenType: 0, // ERC1155
    inputToken,
    minId,
    maxId,
    requiredTotal,
    mode: 0, // ESCROW
    consumeTo,
    outputKey: lootboxKeyAddress,
    outputKeyId,
    outputAmount,
    enabled: true
  });
  await tx.wait();
  console.log("Recipe set (ESCROW)");

  tx = await mixer.freezeRecipe(recipeId);
  await tx.wait();
  console.log("Recipe frozen");

  const r = await mixer.recipes(recipeId);
  console.log(
    JSON.stringify(
      {
        mixer: mixerAddress,
        lootboxKey: lootboxKeyAddress,
        recipeId: recipeId.toString(),
        requiredTotal: r.requiredTotal.toString(),
        mode: Number(r.mode),
        consumeTo: r.consumeTo
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

