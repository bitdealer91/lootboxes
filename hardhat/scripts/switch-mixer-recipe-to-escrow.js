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

  // Allow using frontend RPC var from .env.local.
  if (!process.env.SOMNIA_RPC_URL && process.env.NEXT_PUBLIC_RPC_URL) {
    process.env.SOMNIA_RPC_URL = process.env.NEXT_PUBLIC_RPC_URL;
  }

  mustEnv("SOMNIA_RPC_URL");
  mustEnv("DEPLOYER_PRIVATE_KEY");

  if (hre.network.name !== "somnia") {
    throw new Error("Run with --network somnia");
  }

  const mixerAddress = mustEnv("MIXER_ADDRESS");
  const inputToken = mustEnv("INPUT_TOKEN");
  const outputKey = mustEnv("OUTPUT_KEY");
  const consumeTo = mustEnv("CONSUME_TO");

  const recipeId = BigInt(process.env.RECIPE_ID || "1");
  const minId = BigInt(process.env.MIN_ID || "1");
  const maxId = BigInt(process.env.MAX_ID || "8");
  const requiredTotal = BigInt(process.env.REQUIRED_TOTAL || "32");
  const outputKeyId = BigInt(process.env.OUTPUT_KEY_ID || "1");
  const outputAmount = BigInt(process.env.OUTPUT_AMOUNT || "1");
  const freezeAfter = /^(1|true|yes)$/i.test(process.env.FREEZE_RECIPE || "0");

  const [signer] = await ethers.getSigners();
  const mixer = await ethers.getContractAt("Mixer", mixerAddress, signer);

  const current = await mixer.recipes(recipeId);
  const currentFrozen = await mixer.recipeFrozen(recipeId);

  console.log("Network:", hre.network.name);
  console.log("Signer:", signer.address);
  console.log("Mixer:", mixerAddress);
  console.log("Recipe:", recipeId.toString());
  console.log("Current mode:", Number(current.mode), "(0=ESCROW, 1=BURN)");
  console.log("Current enabled:", current.enabled);
  console.log("Current frozen:", currentFrozen);

  if (currentFrozen) {
    throw new Error(`Recipe ${recipeId.toString()} is frozen and cannot be changed`);
  }

  const recipe = {
    tokenType: 0, // ERC1155
    inputToken,
    minId,
    maxId,
    requiredTotal,
    mode: 0, // ESCROW
    consumeTo,
    outputKey,
    outputKeyId,
    outputAmount,
    enabled: true
  };

  const tx = await mixer.setRecipe(recipeId, recipe);
  console.log("setRecipe tx:", tx.hash);
  await tx.wait();

  if (freezeAfter) {
    const tx2 = await mixer.freezeRecipe(recipeId);
    console.log("freezeRecipe tx:", tx2.hash);
    await tx2.wait();
  }

  const updated = await mixer.recipes(recipeId);
  console.log("Updated mode:", Number(updated.mode), "(0=ESCROW, 1=BURN)");
  console.log("Updated consumeTo:", updated.consumeTo);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
