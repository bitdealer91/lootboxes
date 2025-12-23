import hre from "hardhat";
const { ethers } = hre;

// Fund RewardVaultERC721 with Quills NFTs.
//
// Usage (mock Quills with mint):
// QUILLS_ADDRESS=0x... QUILLS_VAULT_ADDRESS=0x... COUNT=10 \
//   npx hardhat run ./scripts/fund-quills-vault.js --network somniaTest
//
// Usage (deposit existing tokenIds from a real collection):
// QUILLS_ADDRESS=0x... QUILLS_VAULT_ADDRESS=0x... TOKEN_IDS=123,456 \
//   npx hardhat run ./scripts/fund-quills-vault.js --network somniaTest

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

  const quills = await ethers.getContractAt("MockERC721", quillsAddr);
  const vault = await ethers.getContractAt("RewardVaultERC721", vaultAddr);

  let tokenIds;
  const tokenIdsEnv = (process.env.TOKEN_IDS || "").trim();
  if (tokenIdsEnv) {
    tokenIds = tokenIdsEnv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => BigInt(s));
  } else {
    const count = Number.parseInt(process.env.COUNT || "5", 10);
    if (!Number.isFinite(count) || count <= 0) throw new Error("COUNT must be a positive integer");

    const start = await quills.nextId();
    console.log("Minting", count, "Quills… (starting tokenId:", start.toString() + ")");
    for (let i = 0; i < count; i++) {
      await (await quills.mint(deployer.address)).wait();
    }
    tokenIds = Array.from({ length: count }, (_, i) => start + BigInt(i));
  }

  console.log("Approving vault…");
  await (await quills.setApprovalForAll(vaultAddr, true)).wait();

  console.log("Depositing tokenIds:", tokenIds.map((x) => x.toString()).join(", "));
  await (await vault.deposit(tokenIds)).wait();

  const remaining = await vault.remaining();
  console.log("Vault remaining:", remaining.toString());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});


