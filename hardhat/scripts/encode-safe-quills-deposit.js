import hre from "hardhat";

const { ethers } = hre;

/**
 * Prints calldata for two Safe transactions (no private key, no broadcast):
 *   1) Quills ERC721: setApprovalForAll(vault, true)
 *   2) RewardVaultERC721: deposit(tokenIds)
 *
 * Safe does not run JavaScript "inside" the UI — you copy **To** + **Data** (or use Contract interaction + ABI).
 *
 * Usage:
 *   cd hardhat
 *   QUILLS_ADDRESS=0x... QUILLS_VAULT_ADDRESS=0x... TOKEN_IDS=123 npx hardhat run ./scripts/encode-safe-quills-deposit.js --network hardhat
 *
 * TOKEN_IDS: comma-separated, e.g. 123 or 10,11,12
 */

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

async function main() {
  const quills = mustEnv("QUILLS_ADDRESS");
  const vault = mustEnv("QUILLS_VAULT_ADDRESS");
  const rawIds = mustEnv("TOKEN_IDS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (rawIds.length === 0) throw new Error("TOKEN_IDS is empty");
  const tokenIds = rawIds.map((s) => BigInt(s));

  const erc721Iface = new ethers.Interface([
    "function setApprovalForAll(address operator, bool approved) external"
  ]);
  const vaultIface = new ethers.Interface(["function deposit(uint256[] tokenIds) external"]);

  const dataApproval = erc721Iface.encodeFunctionData("setApprovalForAll", [vault, true]);
  const dataDeposit = vaultIface.encodeFunctionData("deposit", [tokenIds]);

  console.log("\n=== Somnia — Safe Transaction Builder inputs ===\n");
  console.log("Add **two** transactions in order (Transaction builder → Add transaction).\n");

  console.log("--- Transaction 1: approve vault on Quills collection ---");
  console.log("Contract (To):", quills);
  console.log("Value (ETH):   0");
  console.log("Data (hex):   ", dataApproval);
  console.log("Decoded:       setApprovalForAll(operator=" + vault + ", approved=true)\n");

  console.log("--- Transaction 2: deposit NFTs into prize vault ---");
  console.log("Contract (To):", vault);
  console.log("Value (ETH):   0");
  console.log("Data (hex):   ", dataDeposit);
  console.log("Decoded:       deposit(tokenIds=[" + tokenIds.map(String).join(", ") + "])\n");

  console.log("=== Safe UI (alternative to raw Data) ===\n");
  console.log("1. Open https://app.safe.global (select the Safe on **Somnia** if your Safe supports this chain).");
  console.log("2. New transaction → Transaction builder.");
  console.log("3. Add transaction → **Contract interaction**.");
  console.log("   Tx1: Contract address = Quills address above; ABI snippet:");
  console.log('   function setApprovalForAll(address operator, bool approved) external');
  console.log("   operator = vault address; approved = true.");
  console.log("4. Add second transaction:");
  console.log("   Contract address = Vault address; ABI snippet:");
  console.log("   function deposit(uint256[] tokenIds) external");
  console.log("   tokenIds = your list (e.g. one id for a smoke test).");
  console.log("\nIf the Safe UI does not list Somnia: use a Safe deployment/wallet that supports chain 5031, or execute the same To+Data from any multisig/tool that can propose txs on Somnia.\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
