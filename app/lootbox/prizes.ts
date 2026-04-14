export type LootboxPrize = {
  /** uint8 from ItemAwarded(itemType) */
  itemType: number;
  title: string;
  description?: string;
  /** Video shown on the tilted reward card */
  videoSrc: string;
};

// IMPORTANT:
// - The actual probability + limits MUST be enforced in the smart contract.
// - This mapping is UI-only (what to show for a given on-chain itemType).

export const PRIZES_BY_ITEM_TYPE: Record<number, LootboxPrize> = {
  0: {
    itemType: 0,
    title: "Quills NFT",
    description: "Limited NFT",
    videoSrc: "/assets/card01.webm"
  },
  1: {
    itemType: 1,
    title: "500 Points",
    description: "Points reward",
    videoSrc: "/assets/500points.webm"
  },
  2: {
    itemType: 2,
    title: "750 Points",
    description: "Points reward",
    videoSrc: "/assets/750points.webm"
  },
  3: {
    itemType: 3,
    title: "1000 Points",
    description: "Points reward",
    videoSrc: "/assets/1000points.webm"
  },
  4: {
    itemType: 4,
    title: "1200 Points",
    description: "Points reward",
    videoSrc: "/assets/1200points.webm"
  },
  5: { itemType: 5, title: "1500 Points", description: "Points reward", videoSrc: "/assets/1500points.webm" },
  6: { itemType: 6, title: "2000 Points", description: "Points reward", videoSrc: "/assets/2000points.webm" },
  7: { itemType: 7, title: "Unused slot", description: "Not configured", videoSrc: "/assets/card01.webm" },
  8: { itemType: 8, title: "Unused slot", description: "Not configured", videoSrc: "/assets/card01.webm" },
  9: { itemType: 9, title: "Unused slot", description: "Not configured", videoSrc: "/assets/card01.webm" }
};

export function formatPrizeTitle(itemType: number): string {
  return PRIZES_BY_ITEM_TYPE[itemType]?.title ?? `Reward #${itemType}`;
}



