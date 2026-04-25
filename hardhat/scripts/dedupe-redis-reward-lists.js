import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
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

function normalizeListEntry(raw) {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") return raw;
  return null;
}

function dedupeRewardItems(items) {
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    const it = normalizeListEntry(raw);
    if (!it || typeof it !== "object") continue;
    const id = it.id;
    if (id == null) continue;
    const sid = String(id);
    if (seen.has(sid)) continue;
    seen.add(sid);
    out.push(it);
  }
  return out;
}

function eventDedupeKey(ev) {
  if (!ev || typeof ev !== "object") return null;
  const o = ev;
  if (o.txHash == null) return null;
  return `${String(o.txHash)}:${String(o.logIndex ?? "")}`;
}

function dedupePointEvents(items) {
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    const ev = normalizeListEntry(raw);
    if (!ev || typeof ev !== "object") continue;
    const k = eventDedupeKey(ev);
    if (!k) {
      out.push(ev);
      continue;
    }
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(ev);
  }
  return out;
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

function resolveCsvPath() {
  const fromEnv = process.env.DEDUPE_CSV;
  if (fromEnv) return path.resolve(process.cwd(), fromEnv);
  return path.resolve(process.cwd(), "../docs/points updated.csv");
}

async function main() {
  loadRootEnvLocal();

  const url = mustEnv("UPSTASH_REDIS_REST_URL");
  const token = mustEnv("UPSTASH_REDIS_REST_TOKEN");
  const chainId = Number.parseInt(process.env.NEXT_PUBLIC_CHAIN_ID || "5031", 10);
  const lootbox = mustEnv("NEXT_PUBLIC_LOOTBOX_ADDRESS").toLowerCase();
  const csvPath = resolveCsvPath();
  const apply = /^(1|true|yes)$/i.test(process.env.APPLY || "0");

  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV not found: ${csvPath} (set DEDUPE_CSV or add docs/points updated.csv)`);
  }

  const redis = new Redis({ url, token });
  const lines = fs.readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("CSV is empty");
  const header = parseCsvLine(lines[0]);
  const iAddress = header.indexOf("address");
  if (iAddress === -1) throw new Error("CSV must have address column");

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const address = (cols[iAddress] || "").trim().toLowerCase();
    if (!address || !address.startsWith("0x")) continue;
    rows.push({ address });
  }

  console.log(`Wallets: ${rows.length} | ${apply ? "APPLY" : "DRY-RUN"}`);

  let fixedRewards = 0;
  let fixedEvents = 0;
  let skipped = 0;

  for (const { address } of rows) {
    const keyRewards = `lootboxes:rewards:${chainId}:${address}:${lootbox}`;
    const keyEvents = `lootboxes:points:events:${chainId}:${address}:${lootbox}`;

    const rawRewards = await retry(
      () => withTimeout(redis.lrange(keyRewards, 0, 199), 12_000, `lrange rewards ${address}`),
      3,
      "lrange rewards"
    );
    const rawEvents = await retry(
      () => withTimeout(redis.lrange(keyEvents, 0, 199), 12_000, `lrange events ${address}`),
      3,
      "lrange events"
    );

    const rewards = dedupeRewardItems(rawRewards);
    const evts = dedupePointEvents(rawEvents);
    const rawR = Array.isArray(rawRewards) ? rawRewards.length : 0;
    const rawE = Array.isArray(rawEvents) ? rawEvents.length : 0;
    const rChanged = rewards.length !== rawR;
    const eChanged = evts.length !== rawE;

    if (!rChanged && !eChanged) {
      skipped += 1;
      continue;
    }

    if (apply) {
      if (rChanged) {
        await retry(() => withTimeout(redis.del(keyRewards), 10_000, `del rewards ${address}`), 3, "del rewards");
        if (rewards.length) {
          await retry(
            () => withTimeout(redis.rpush(keyRewards, ...rewards), 15_000, `rpush rewards ${address}`),
            3,
            "rpush rewards"
          );
        }
        fixedRewards += 1;
      }
      if (eChanged) {
        await retry(() => withTimeout(redis.del(keyEvents), 10_000, `del events ${address}`), 3, "del events");
        if (evts.length) {
          await retry(
            () => withTimeout(redis.rpush(keyEvents, ...evts), 15_000, `rpush events ${address}`),
            3,
            "rpush events"
          );
        }
        fixedEvents += 1;
      }
    } else {
      if (rChanged) {
        console.log(`[dry] ${address} rewards ${rawR} -> ${rewards.length}`);
        fixedRewards += 1;
      }
      if (eChanged) {
        console.log(`[dry] ${address} events ${rawE} -> ${evts.length}`);
        fixedEvents += 1;
      }
    }
  }

  const summary = {
    apply,
    chainId,
    lootbox,
    csvPath,
    fixedRewardsKeys: fixedRewards,
    fixedEventsKeys: fixedEvents,
    skippedNoop: skipped
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
