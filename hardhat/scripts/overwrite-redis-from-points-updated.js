import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config as dotenvConfig } from "dotenv";
import { Redis } from "@upstash/redis";

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

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseRewardsArray(raw) {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!inner) return [];
  return inner
    .split(",")
    .map((x) => Number.parseInt(x.trim(), 10))
    .filter((x) => Number.isFinite(x) && x > 0);
}

function itemTypeFromPoints(points) {
  switch (points) {
    case 125:
      return 0;
    case 180:
      return 1;
    case 250:
      return 2;
    case 300:
      return 3;
    case 375:
      return 4;
    case 500:
      return 5;
    default:
      return 255;
  }
}

function mkPseudoTxHash(address, idx, points) {
  const h = crypto.createHash("sha256").update(`${address}:${idx}:${points}`).digest("hex");
  return `0x${h}`;
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function retry(fn, attempts, label) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${String(lastErr)}`);
}

async function main() {
  loadRootEnvLocal();

  const url = mustEnv("UPSTASH_REDIS_REST_URL");
  const token = mustEnv("UPSTASH_REDIS_REST_TOKEN");
  const chainId = Number.parseInt(process.env.NEXT_PUBLIC_CHAIN_ID || "5031", 10);
  const lootbox = mustEnv("NEXT_PUBLIC_LOOTBOX_ADDRESS").toLowerCase();
  const csvPath = path.resolve(process.cwd(), "../docs/points updated.csv");
  const apply = /^(1|true|yes)$/i.test(process.env.APPLY || "0");

  if (!Number.isFinite(chainId) || chainId <= 0) throw new Error("Bad NEXT_PUBLIC_CHAIN_ID");
  if (!fs.existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);

  const redis = new Redis({ url, token });
  const lines = fs.readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("CSV is empty");

  const header = parseCsvLine(lines[0]);
  const iAddress = header.indexOf("address");
  const iRewards = header.indexOf("rewards_random2");
  if (iAddress === -1 || iRewards === -1) {
    throw new Error("CSV must have address and rewards_random2 columns");
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const address = (cols[iAddress] || "").trim().toLowerCase();
    const rewards = parseRewardsArray((cols[iRewards] || "").trim());
    if (!address || !address.startsWith("0x")) continue;
    rows.push({ address, rewards });
  }

  console.log(`Parsed rows: ${rows.length}`);
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);

  const now = Date.now();
  let replaced = 0;
  let failed = 0;
  for (const row of rows) {
    const keyRewards = `lootboxes:rewards:${chainId}:${row.address}:${lootbox}`;
    const keyPoints = `lootboxes:points:${chainId}:${row.address}:${lootbox}`;
    const keyEvents = `lootboxes:points:events:${chainId}:${row.address}:${lootbox}`;

    const rewards = row.rewards.slice(0, 2); // product request: one or two values
    const total = rewards.reduce((a, b) => a + b, 0);

    const eventsPayload = [];
    const itemsPayload = [];
    for (let i = 0; i < rewards.length; i++) {
      const points = rewards[i];
      const txHash = mkPseudoTxHash(row.address, i, points);
      const newTotal = rewards.slice(0, i + 1).reduce((a, b) => a + b, 0);
      eventsPayload.push({
        txHash,
        chainId,
        lootbox,
        address: row.address,
        amount: String(points),
        newTotal: String(newTotal),
        logIndex: i,
        createdAt: now - i
      });
      itemsPayload.push({
        id: `legacy-${i}-${txHash}`,
        chainId,
        lootbox,
        txHash,
        itemType: itemTypeFromPoints(points),
        token: "0x0000000000000000000000000000000000000000",
        amount: String(points),
        pointsTotal: String(newTotal),
        createdAt: now - i
      });
    }

    if (apply) {
      try {
        // Overwrite wallet-level history with the new source of truth.
        await retry(() => withTimeout(redis.del(keyRewards), 10_000, `del rewards ${row.address}`), 3, "del rewards");
        await retry(() => withTimeout(redis.del(keyEvents), 10_000, `del events ${row.address}`), 3, "del events");
        await retry(() => withTimeout(redis.set(keyPoints, String(total)), 10_000, `set points ${row.address}`), 3, "set points");
        // One element per LPUSH: multi-arg lpush in some REST/Upstash paths duplicated entries.
        for (let e = 0; e < eventsPayload.length; e += 1) {
          const ev = eventsPayload[e];
          await retry(
            () => withTimeout(redis.lpush(keyEvents, ev), 10_000, `lpush event ${e} ${row.address}`),
            3,
            "lpush events"
          );
        }
        for (let r = 0; r < itemsPayload.length; r += 1) {
          const it = itemsPayload[r];
          await retry(
            () => withTimeout(redis.lpush(keyRewards, it), 10_000, `lpush reward ${r} ${row.address}`),
            3,
            "lpush rewards"
          );
        }
      } catch (e) {
        failed += 1;
        console.error(`Failed ${row.address}:`, e instanceof Error ? e.message : String(e));
        continue;
      }
    }
    replaced += 1;
    if (replaced % 25 === 0) {
      console.log(`Progress: ${replaced}/${rows.length}`);
    }
  }

  console.log(JSON.stringify({ replaced, failed, chainId, lootbox, apply }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

