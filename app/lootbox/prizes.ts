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

/** S5 / SomniaLootboxVRFS5: points slots 0..5, Quills NFT at 6 (must match deployed prize table). */
export const PRIZES_BY_ITEM_TYPE: Record<number, LootboxPrize> = {
  0: {
    itemType: 0,
    title: "125 Points for S5",
    description: "Points reward",
    videoSrc: "/assets/125points.webm"
  },
  1: {
    itemType: 1,
    title: "180 Points for S5",
    description: "Points reward",
    videoSrc: "/assets/180points.webm"
  },
  2: {
    itemType: 2,
    title: "250 Points for S5",
    description: "Points reward",
    videoSrc: "/assets/250points.webm"
  },
  3: {
    itemType: 3,
    title: "300 Points for S5",
    description: "Points reward",
    videoSrc: "/assets/300points.webm"
  },
  4: {
    itemType: 4,
    title: "375 Points for S5",
    description: "Points reward",
    videoSrc: "/assets/375points.webm"
  },
  5: {
    itemType: 5,
    title: "500 Points for S5",
    description: "Points reward",
    videoSrc: "/assets/500points.webm"
  },
  6: {
    itemType: 6,
    title: "Quills NFT",
    description: "Limited NFT",
    videoSrc: "/assets/card01.webm"
  }
};

export function formatPrizeTitle(itemType: number): string {
  return PRIZES_BY_ITEM_TYPE[itemType]?.title ?? `Reward #${itemType}`;
}
