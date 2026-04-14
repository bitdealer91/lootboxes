import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import {
  eventDedupeId,
  itemEntriesForUser,
  lootboxRewardAbi,
  parseLootboxLogs,
  pointsAccrualsForUser
} from "./rewards-indexing";

describe("rewards-indexing", () => {
  const lootbox = "0x1111111111111111111111111111111111111111" as Hex;
  const user = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as Hex;

  it("dedupe id normalizes tx hash", () => {
    expect(eventDedupeId("0xAAA", 5)).toBe("0xaaa:5");
  });

  it("pointsAccrualsForUser yields one row per PointsAwarded with chain-aligned newTotal", () => {
    const tx = ("0x" + "ab".repeat(32)) as Hex;
    const parsed = [
      {
        eventName: "ItemAwarded" as const,
        logIndex: 1,
        args: {
          user,
          itemType: 3,
          token: "0x0000000000000000000000000000000000000000" as Hex,
          id: 0n,
          amount: 500n
        }
      },
      {
        eventName: "PointsAwarded" as const,
        logIndex: 2,
        args: { user, amount: 500n, newTotal: 500n }
      }
    ];
    const acc = pointsAccrualsForUser(parsed, user, tx);
    expect(acc).toHaveLength(1);
    expect(acc[0]!.newTotal).toBe(500n);
    expect(acc[0]!.eventId).toBe(`${tx}:2`);
  });

  it("ItemAwarded + PointsAwarded: items list does not imply extra point rows", () => {
    const tx = ("0x" + "ef".repeat(32)) as Hex;
    const parsed = [
      {
        eventName: "ItemAwarded" as const,
        logIndex: 1,
        args: {
          user,
          itemType: 4,
          token: "0x0000000000000000000000000000000000000000" as Hex,
          id: 0n,
          amount: 1200n
        }
      },
      {
        eventName: "PointsAwarded" as const,
        logIndex: 2,
        args: { user, amount: 1200n, newTotal: 1200n }
      }
    ];
    expect(pointsAccrualsForUser(parsed, user, tx)).toHaveLength(1);
    expect(itemEntriesForUser(parsed, user, tx, 5031, lootbox)).toHaveLength(1);
  });

  it("parseLootboxLogs decodes a receipt log", () => {
    const topics = encodeEventTopics({
      abi: lootboxRewardAbi,
      eventName: "ItemAwarded",
      args: { user }
    });
    const data = encodeAbiParameters(
      [
        { name: "itemType", type: "uint8" },
        { name: "token", type: "address" },
        { name: "id", type: "uint256" },
        { name: "amount", type: "uint256" }
      ],
      [5, "0x0000000000000000000000000000000000000000", 0n, 1200n]
    );
    const txh = ("0x" + "dd".repeat(32)) as Hex;
    const decoded = parseLootboxLogs(lootbox, [
      {
        address: lootbox,
        blockHash: null,
        blockNumber: 1n,
        logIndex: 3,
        transactionIndex: 0,
        removed: false,
        data,
        topics: topics as [Hex, ...Hex[]],
        transactionHash: txh
      }
    ]);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.eventName).toBe("ItemAwarded");
  });
});
