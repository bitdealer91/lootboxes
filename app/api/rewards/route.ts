import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { createPublicClient, http, isAddress, isHex, type Hex } from "viem";
import {
  itemEntriesForUser,
  parseLootboxLogs,
  pointsAccrualsForUser
} from "@/lib/rewards-indexing";

export const runtime = "nodejs";

type RewardEntry = {
  id: string;
  chainId: number;
  lootbox: `0x${string}`;
  txHash: `0x${string}`;
  itemType: number;
  token: `0x${string}`;
  amount: string;
  pointsTotal?: string;
  createdAt: number;
};

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function keyFor(address: string, chainId: number, lootbox: string) {
  return `lootboxes:rewards:${chainId}:${address.toLowerCase()}:${lootbox.toLowerCase()}`;
}

function pointsKeyFor(address: string, chainId: number, lootbox: string) {
  return `lootboxes:points:${chainId}:${address.toLowerCase()}:${lootbox.toLowerCase()}`;
}

function pointsEventsKeyFor(address: string, chainId: number, lootbox: string) {
  return `lootboxes:points:events:${chainId}:${address.toLowerCase()}:${lootbox.toLowerCase()}`;
}

function pointsSeenSetFor(chainId: number, lootbox: string) {
  return `lootboxes:points:seen:${chainId}:${lootbox.toLowerCase()}`;
}

function itemSeenSetFor(chainId: number, lootbox: string) {
  return `lootboxes:rewards:itemseen:${chainId}:${lootbox.toLowerCase()}`;
}

function getRpcUrl() {
  return process.env.RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || "";
}

/** Stale import path could duplicate the same `id` in the list; keep lrange order (newest first). */
function dedupeRewardItemsById(items: RewardEntry[]): RewardEntry[] {
  const seen = new Set<string>();
  const out: RewardEntry[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function dedupePointsEvents(events: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const ev of events) {
    if (!ev || typeof ev !== "object") {
      out.push(ev);
      continue;
    }
    const o = ev as Record<string, unknown>;
    const k = `${String(o.txHash)}:${String(o.logIndex)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(ev);
  }
  return out;
}

export async function GET(req: Request) {
  const redis = getRedis();
  if (!redis) {
    return NextResponse.json({ error: "Redis not configured" }, { status: 501 });
  }

  const { searchParams } = new URL(req.url);
  const address = searchParams.get("address") || "";
  const lootbox = searchParams.get("lootbox") || "";
  const chainId = Number(searchParams.get("chainId") || "");
  const kind = (searchParams.get("kind") || "").toLowerCase();

  if (!isAddress(address)) return NextResponse.json({ error: "Bad address" }, { status: 400 });
  if (!isAddress(lootbox)) return NextResponse.json({ error: "Bad lootbox" }, { status: 400 });
  if (!Number.isFinite(chainId) || chainId <= 0) return NextResponse.json({ error: "Bad chainId" }, { status: 400 });

  if (kind === "points") {
    const pk = pointsKeyFor(address, chainId, lootbox);
    const ek = pointsEventsKeyFor(address, chainId, lootbox);
    const total = ((await redis.get(pk)) as string | null) || "0";
    const includeHistory = searchParams.get("history") === "1";
    if (!includeHistory) return NextResponse.json({ total });
    const events = dedupePointsEvents((await redis.lrange(ek, 0, 199)) as unknown[]);
    return NextResponse.json({ total, events });
  }

  const key = keyFor(address, chainId, lootbox);
  const items = dedupeRewardItemsById(
    (await redis.lrange(key, 0, 199)) as RewardEntry[]
  );
  return NextResponse.json({ items });
}

export async function POST(req: Request) {
  const redis = getRedis();
  if (!redis) {
    return NextResponse.json({ error: "Redis not configured" }, { status: 501 });
  }

  const body = (await req.json().catch(() => null)) as null | {
    address?: string;
    lootbox?: string;
    chainId?: number;
    txHash?: string;
  };

  const address = body?.address || "";
  const lootbox = body?.lootbox || "";
  const chainId = Number(body?.chainId || 0);
  const txHash = (body?.txHash || "") as Hex;

  if (!isAddress(address)) return NextResponse.json({ error: "Bad address" }, { status: 400 });
  if (!isAddress(lootbox)) return NextResponse.json({ error: "Bad lootbox" }, { status: 400 });
  if (!Number.isFinite(chainId) || chainId <= 0) return NextResponse.json({ error: "Bad chainId" }, { status: 400 });
  if (!isHex(txHash) || txHash.length !== 66) return NextResponse.json({ error: "Bad txHash" }, { status: 400 });

  const rpcUrl = getRpcUrl();
  if (!rpcUrl) return NextResponse.json({ error: "RPC_URL not configured" }, { status: 500 });

  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  const lootboxHex = lootbox as Hex;
  const parsed = parseLootboxLogs(lootboxHex, receipt.logs);

  const addrLc = address.toLowerCase();
  const hasAward = parsed.some(
    (e) =>
      (e.eventName === "ItemAwarded" && e.args.user.toLowerCase() === addrLc) ||
      (e.eventName === "PointsAwarded" && e.args.user.toLowerCase() === addrLc)
  );

  if (!hasAward) {
    return NextResponse.json({ error: "No ItemAwarded/PointsAwarded for this user and lootbox" }, { status: 400 });
  }

  const pointsSeen = pointsSeenSetFor(chainId, lootbox);
  const itemSeen = itemSeenSetFor(chainId, lootbox);

  let pointsNewEvents = 0;
  let itemsNew = 0;
  const createdAt = Date.now();
  const listKey = keyFor(address, chainId, lootbox);
  const pk = pointsKeyFor(address, chainId, lootbox);
  const ek = pointsEventsKeyFor(address, chainId, lootbox);

  // Chain-anchored points: each PointsAwarded carries authoritative `newTotal`. Idempotent per log.
  const accruals = pointsAccrualsForUser(parsed, address, txHash);
  let lastPointsTotal: string | undefined;
  for (const a of accruals) {
    const added = await redis.sadd(pointsSeen, a.eventId);
    if (added === 0) continue;
    pointsNewEvents += 1;
    lastPointsTotal = a.newTotal.toString();
    await redis.set(pk, lastPointsTotal);
    await redis.lpush(ek, {
      txHash,
      chainId,
      lootbox,
      address,
      amount: a.amount.toString(),
      newTotal: lastPointsTotal,
      logIndex: a.logIndex,
      createdAt
    });
    await redis.ltrim(ek, 0, 199);
  }

  const pointsTotalForItems = accruals.length ? accruals[accruals.length - 1]!.newTotal.toString() : undefined;

  for (const row of itemEntriesForUser(parsed, address, txHash, chainId, lootboxHex)) {
    const added = await redis.sadd(itemSeen, row.eventId);
    if (added === 0) continue;
    itemsNew += 1;
    const item: RewardEntry = {
      id: `${row.logIndex}-${txHash}`,
      chainId: row.chainId,
      lootbox: row.lootbox as `0x${string}`,
      txHash: row.txHash as `0x${string}`,
      itemType: row.itemType,
      token: row.token,
      amount: row.amount.toString(),
      pointsTotal: pointsTotalForItems,
      createdAt
    };
    await redis.lpush(listKey, item);
    await redis.ltrim(listKey, 0, 199);
  }

  if (pointsNewEvents === 0 && itemsNew === 0) {
    return NextResponse.json({ ok: true, deduped: true });
  }

  return NextResponse.json({
    ok: true,
    indexed: { pointsEvents: pointsNewEvents, items: itemsNew },
    lastPointsTotal: lastPointsTotal ?? null
  });
}
