import "dotenv/config";
import hre from "hardhat";

const { ethers } = hre;

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function main() {
  if (hre.network.name !== "somnia") throw new Error("Run with --network somnia");
  const vaultAddr = mustEnv("VAULT_ADDRESS");
  const lootboxAddr = mustEnv("LOOTBOX_ADDRESS");
  const [signer] = await ethers.getSigners();
  const vault = await ethers.getContractAt("RewardVaultERC721", vaultAddr, signer);
  const tx = await vault.setLootbox(lootboxAddr);
  console.log("setLootbox tx:", tx.hash);
  await tx.wait();
  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

