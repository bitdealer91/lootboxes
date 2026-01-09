import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { createPublicClient, http, isAddress, isHex, parseAbi, parseEventLogs } from "viem";

export const runtime = "nodejs";

const lootboxAbi = parseAbi([
  "event ItemAwarded(address indexed user, uint8 itemType, address token, uint256 id, uint256 amount)",
  "event PointsAwarded(address indexed user, uint256 amount, uint256 newTotal)"
]);

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

function seenKeyFor(chainId: number, lootbox: string) {
  return `lootboxes:rewards:seen:${chainId}:${lootbox.toLowerCase()}`;
}

function pointsKeyFor(address: string, chainId: number, lootbox: string) {
  return `lootboxes:points:${chainId}:${address.toLowerCase()}:${lootbox.toLowerCase()}`;
}

function pointsEventsKeyFor(address: string, chainId: number, lootbox: string) {
  return `lootboxes:points:events:${chainId}:${address.toLowerCase()}:${lootbox.toLowerCase()}`;
}

function getRpcUrl() {
  return process.env.RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || process.env.SOMNIA_TEST_RPC_URL || "";
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
    const events = (await redis.lrange(ek, 0, 199)) as unknown[];
    return NextResponse.json({ total, events });
  }

  const key = keyFor(address, chainId, lootbox);
  const items = (await redis.lrange(key, 0, 199)) as RewardEntry[];
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
  const txHash = body?.txHash || "";

  if (!isAddress(address)) return NextResponse.json({ error: "Bad address" }, { status: 400 });
  if (!isAddress(lootbox)) return NextResponse.json({ error: "Bad lootbox" }, { status: 400 });
  if (!Number.isFinite(chainId) || chainId <= 0) return NextResponse.json({ error: "Bad chainId" }, { status: 400 });
  if (!isHex(txHash) || txHash.length !== 66) return NextResponse.json({ error: "Bad txHash" }, { status: 400 });

  const rpcUrl = getRpcUrl();
  if (!rpcUrl) return NextResponse.json({ error: "RPC_URL not configured" }, { status: 500 });

  const publicClient = createPublicClient({ transport: http(rpcUrl) });

  // Verify on-chain: tx contains ItemAwarded for this user emitted by this lootbox.
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });

  const logs = receipt.logs.filter((l) => l.address.toLowerCase() === lootbox.toLowerCase());
  const decoded = parseEventLogs({ abi: lootboxAbi, logs });
  const awarded = decoded.find(
    (e) => e.eventName === "ItemAwarded" && (e.args as { user?: string }).user?.toLowerCase() === address.toLowerCase()
  );
  const pointsAwarded = decoded.find(
    (e) => e.eventName === "PointsAwarded" && (e.args as { user?: string }).user?.toLowerCase() === address.toLowerCase()
  );

  if (!awarded) {
    return NextResponse.json({ error: "No ItemAwarded for this user/lootbox" }, { status: 400 });
  }

  const args = awarded.args as { itemType: number; token: `0x${string}`; amount: bigint };
  const itemType = Number(args.itemType);
  const isPoints = itemType >= 5 && itemType <= 9;

  let pointsTotal: string | undefined;
  if (isPoints && pointsAwarded) {
    const p = pointsAwarded.args as { amount: bigint; newTotal: bigint };
    pointsTotal = (p.newTotal ?? 0n).toString();
  }
  const item: RewardEntry = {
    id: `${Date.now()}-${txHash}`,
    chainId,
    lootbox: lootbox as `0x${string}`,
    txHash: txHash as `0x${string}`,
    itemType,
    token: args.token,
    amount: (args.amount ?? 0n).toString(),
    pointsTotal,
    createdAt: Date.now()
  };

  const listKey = keyFor(address, chainId, lootbox);
  const seenKey = seenKeyFor(chainId, lootbox);

  // Dedupe by txHash globally per (chainId, lootbox)
  const added = await redis.sadd(seenKey, txHash);
  if (added === 0) {
    return NextResponse.json({ ok: true, deduped: true });
  }

  await redis.lpush(listKey, item);
  await redis.ltrim(listKey, 0, 199);

  // Also persist points totals for quest platform (optional use)
  if (isPoints && pointsTotal !== undefined) {
    const pk = pointsKeyFor(address, chainId, lootbox);
    const ek = pointsEventsKeyFor(address, chainId, lootbox);
    await redis.set(pk, pointsTotal);
    await redis.lpush(ek, {
      txHash,
      chainId,
      lootbox,
      address,
      itemType,
      amount: item.amount,
      newTotal: pointsTotal,
      createdAt: item.createdAt
    });
    await redis.ltrim(ek, 0, 199);
  }

  return NextResponse.json({ ok: true, item });
}



