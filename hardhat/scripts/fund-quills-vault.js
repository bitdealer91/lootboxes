import hre from "hardhat";
const { ethers } = hre;

// Fund RewardVaultERC721 with Quills NFTs.
//
// Usage (deposit existing tokenIds from a real collection):
// QUILLS_ADDRESS=0x... QUILLS_VAULT_ADDRESS=0x... TOKEN_IDS=123,456 \
//   npx hardhat run ./scripts/fund-quills-vault.js --network somnia

async function main() {
  await hre.run("compile");

  const quillsAddr = process.env.QUILLS_ADDRESS;
  const vaultAddr = process.env.QUILLS_VAULT_ADDRESS;
  if (!quillsAddr || !vaultAddr) {
    throw new Error("Set QUILLS_ADDRESS and QUILLS_VAULT_ADDRESS env vars.");
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Quills:", quillsAddr);
  console.log("Vault:", vaultAddr);

  // Use a minimal ERC721 ABI (real mainnet collection is NOT MockERC721).
  const quills = await ethers.getContractAt(
    [
      "function setApprovalForAll(address operator, bool approved) external",
      "function isApprovedForAll(address owner, address operator) view returns (bool)"
    ],
    quillsAddr
  );
  const vault = await ethers.getContractAt("RewardVaultERC721", vaultAddr);

  let tokenIds;
  const tokenIdsEnv = (process.env.TOKEN_IDS || "").trim();
  if (!tokenIdsEnv) throw new Error("Set TOKEN_IDS=123,456 (comma-separated tokenIds) for mainnet deposits.");
  tokenIds = tokenIdsEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => BigInt(s));

  const approved = await quills.isApprovedForAll(deployer.address, vaultAddr);
  if (!approved) {
    console.log("Approving vault…");
    await (await quills.setApprovalForAll(vaultAddr, true)).wait();
  } else {
    console.log("Vault already approved.");
  }

  console.log("Depositing tokenIds:", tokenIds.map((x) => x.toString()).join(", "));
  await (await vault.deposit(tokenIds)).wait();

  const remaining = await vault.remaining();
  console.log("Vault remaining:", remaining.toString());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});


