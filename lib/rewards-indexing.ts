import { decodeEventLog, type Hex, type Log, parseAbi } from "viem";

export const lootboxRewardAbi = parseAbi([
  "event ItemAwarded(address indexed user, uint8 itemType, address token, uint256 id, uint256 amount)",
  "event PointsAwarded(address indexed user, uint256 amount, uint256 newTotal)"
]);

export type ParsedLootboxLog =
  | {
      eventName: "ItemAwarded";
      logIndex: number;
      args: { user: Hex; itemType: number; token: Hex; id: bigint; amount: bigint };
    }
  | {
      eventName: "PointsAwarded";
      logIndex: number;
      args: { user: Hex; amount: bigint; newTotal: bigint };
    };

export function eventDedupeId(txHash: Hex, logIndex: number): string {
  return `${txHash.toLowerCase()}:${logIndex}`;
}

/** Decode SomniaLootbox / compatible `ItemAwarded` + `PointsAwarded` logs for one receipt, sorted by log index. */
export function parseLootboxLogs(lootbox: Hex, logs: Log[]): ParsedLootboxLog[] {
  const lb = lootbox.toLowerCase();
  const out: ParsedLootboxLog[] = [];

  for (const log of logs) {
    if (!log.address || log.address.toLowerCase() !== lb) continue;
    if (!log.topics?.length) continue;
    try {
      const decoded = decodeEventLog({
        abi: lootboxRewardAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]]
      });
      const logIndex = Number(log.logIndex);
      if (decoded.eventName === "ItemAwarded") {
        const a = decoded.args as { user: Hex; itemType: number; token: Hex; id: bigint; amount: bigint };
        out.push({ eventName: "ItemAwarded", logIndex, args: a });
      } else if (decoded.eventName === "PointsAwarded") {
        const a = decoded.args as { user: Hex; amount: bigint; newTotal: bigint };
        out.push({ eventName: "PointsAwarded", logIndex, args: a });
      }
    } catch {
      /* not a matching event */
    }
  }

  out.sort((x, y) => x.logIndex - y.logIndex);
  return out;
}

/** Points rows to apply if each `eventId` is not yet in the seen-set (caller checks Redis SADD). */
export function pointsAccrualsForUser(parsed: ParsedLootboxLog[], userLower: string, txHash: Hex) {
  const u = userLower.toLowerCase();
  return parsed
    .filter((e): e is Extract<ParsedLootboxLog, { eventName: "PointsAwarded" }> => e.eventName === "PointsAwarded")
    .filter((e) => e.args.user.toLowerCase() === u)
    .map((e) => ({
      eventId: eventDedupeId(txHash, e.logIndex),
      newTotal: e.args.newTotal,
      amount: e.args.amount,
      logIndex: e.logIndex
    }));
}

export function itemEntriesForUser(parsed: ParsedLootboxLog[], userLower: string, txHash: Hex, chainId: number, lootbox: Hex) {
  const u = userLower.toLowerCase();
  return parsed
    .filter((e): e is Extract<ParsedLootboxLog, { eventName: "ItemAwarded" }> => e.eventName === "ItemAwarded")
    .filter((e) => e.args.user.toLowerCase() === u)
    .map((e) => ({
      eventId: eventDedupeId(txHash, e.logIndex),
      itemType: Number(e.args.itemType),
      token: e.args.token,
      amount: e.args.amount,
      logIndex: e.logIndex,
      chainId,
      lootbox,
      txHash
    }));
}
