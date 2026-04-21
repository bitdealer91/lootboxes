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

async function snapshotPrizes(contract, blockTag) {
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const p = await contract.prizes(i, { blockTag });
    rows.push({
      slot: i,
      remaining: Number(p.remaining),
      kind: Number(p.kind),
      token: p.token,
      amount: p.amount.toString()
    });
  }
  const total = await contract.remainingTotal({ blockTag });
  return { total: Number(total), rows };
}

async function main() {
  loadRootEnvLocal();

  if (!process.env.SOMNIA_RPC_URL && process.env.NEXT_PUBLIC_RPC_URL) {
    process.env.SOMNIA_RPC_URL = process.env.NEXT_PUBLIC_RPC_URL;
  }
  const rpcUrl = mustEnv("SOMNIA_RPC_URL");

  const lootboxAddress = mustEnv("LOOTBOX_ADDRESS");
  const txHash = mustEnv("TX_HASH");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const lootbox = new ethers.Contract(
    lootboxAddress,
    [
      "function prizes(uint256) view returns (uint32 remaining,uint8 kind,address token,uint256 amount)",
      "function remainingTotal() view returns (uint256)",
      "event ItemAwarded(address indexed user,uint8 itemType,address token,uint256 id,uint256 amount)"
    ],
    provider
  );

  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error(`Receipt not found for tx: ${txHash}`);
  if (receipt.status !== 1) throw new Error(`Tx reverted: ${txHash}`);
  if (!receipt.blockNumber || receipt.blockNumber <= 0) throw new Error("Bad block number in receipt");

  const beforeBlock = receipt.blockNumber - 1;
  const afterBlock = receipt.blockNumber;

  const [before, after] = await Promise.all([snapshotPrizes(lootbox, beforeBlock), snapshotPrizes(lootbox, afterBlock)]);

  let awarded = null;
  for (const log of receipt.logs) {
    try {
      const parsed = lootbox.interface.parseLog(log);
      if (parsed && parsed.name === "ItemAwarded") {
        awarded = {
          user: parsed.args.user,
          itemType: Number(parsed.args.itemType),
          token: parsed.args.token,
          id: parsed.args.id.toString(),
          amount: parsed.args.amount.toString()
        };
        break;
      }
    } catch {
      // ignore non-lootbox logs
    }
  }

  const changes = after.rows
    .map((a, i) => {
      const b = before.rows[i];
      return {
        slot: a.slot,
        before: b.remaining,
        after: a.remaining,
        delta: a.remaining - b.remaining,
        kind: a.kind
      };
    })
    .filter((x) => x.delta !== 0);

  console.log("Lootbox:", lootboxAddress);
  console.log("Tx:", txHash);
  console.log("Block:", receipt.blockNumber);
  console.log("Awarded:", awarded);
  console.log("remainingTotal:", { before: before.total, after: after.total, delta: after.total - before.total });
  console.log("Changed slots:", changes);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
