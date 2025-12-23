"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useChainId, useDisconnect, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import { parseAbi, parseAbiItem, parseEventLogs } from "viem";
import { useReown } from "./providers/AppKitProvider";
import { somniaChain } from "./providers/chains";
// @ts-expect-error Aurora is a JS component with no types
import Aurora from "./lootbox/Aurora";
// @ts-expect-error TiltedCard is a JS component with no types
import TiltedCard from "./lootbox/TiltedCard";
import { formatPrizeTitle, PRIZES_BY_ITEM_TYPE } from "./lootbox/prizes";

const LOOTBOX = (process.env.NEXT_PUBLIC_LOOTBOX_ADDRESS || "0x0000000000000000000000000000000000000000") as `0x${string}`;
// Input keys that are mixed into lootbox keys (Odyssey keys on mainnet; TestKeys1155 on testnet)
const INPUT_KEYS = (process.env.NEXT_PUBLIC_INPUT_KEYS_ADDRESS ||
  // backward compatible with the dedicated testnet page env
  process.env.NEXT_PUBLIC_TEST_INPUT_KEYS_ADDRESS ||
  process.env.NEXT_PUBLIC_KEYS_ADDRESS ||
  "0x2d535a2588E7c3f5F213F3b3324F44E146Ca5306") as `0x${string}`;
// Mixer that converts input keys -> LootboxKey
const MIXER = (process.env.NEXT_PUBLIC_MIXER_ADDRESS || "0x0000000000000000000000000000000000000000") as `0x${string}`;
// Lootbox key (ERC1155) that is burned to open the lootbox
const LOOTBOX_KEYS = (process.env.NEXT_PUBLIC_LOOTBOX_KEY_ADDRESS || process.env.NEXT_PUBLIC_KEYS_ADDRESS || "0x0000000000000000000000000000000000000000") as `0x${string}`;

const INPUT_KEY_IDS = (process.env.NEXT_PUBLIC_INPUT_KEY_IDS || process.env.NEXT_PUBLIC_KEY_IDS || "1,2,3,4,5,6,7,8")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean)
  .map((id) => BigInt(id));

const LOOTBOX_KEY_IDS = (process.env.NEXT_PUBLIC_LOOTBOX_KEY_IDS || "1")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean)
  .map((id) => BigInt(id));

const MIX_RECIPE_ID = BigInt(process.env.NEXT_PUBLIC_RECIPE_ID || "1");
const MIX_REQUIRED_TOTAL = BigInt(process.env.NEXT_PUBLIC_MIX_REQUIRED_TOTAL || "32");
const ENABLE_TEST_MINT = process.env.NEXT_PUBLIC_ENABLE_TEST_MINT === "true";
const ENABLE_REWARDS_REDIS = process.env.NEXT_PUBLIC_ENABLE_REWARDS_REDIS === "true";
const EXPLORER_TX_BASE =
  process.env.NEXT_PUBLIC_EXPLORER_TX_BASE ||
  (Number(process.env.NEXT_PUBLIC_CHAIN_ID || "0") === 50312 ? "https://shannon-explorer.somnia.network/tx/" : "");

const lootboxAbi = parseAbi([
  "function openWithKey(uint256 keyId) external",
  "event OpenRequested(address indexed user, uint256 requestId)",
  "event ItemAwarded(address indexed user, uint8 itemType, address token, uint256 id, uint256 amount)"
]);

const itemAwardedEvent = parseAbiItem(
  "event ItemAwarded(address indexed user, uint8 itemType, address token, uint256 id, uint256 amount)"
);

const keysAbi = parseAbi([
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function setApprovalForAll(address operator, bool approved) external",
  "function isApprovedForAll(address account, address operator) view returns (bool)",
  // TestKeys1155 faucet (testnet only)
  "function mintBatchTo(address to, uint256[] ids, uint256[] amounts) external"
]);
const mixerAbi = parseAbi(["function mixERC1155(uint256 recipeId, uint256[] ids, uint256[] amounts) external"]);
const lootboxClaimsAbi = parseAbi([
  "function claimErc20(address token) external",
  "function claimErc721(address nft, uint256 maxCount) external",
  "function claimNative() external"
]);
function buildShareText(itemType: number): string {
  switch (itemType) {
    case 0:
      return "Luck was on my side—just pulled a Quills NFT from the Somnia Lootbox. #Somnia #Lootbox #Web3";
    case 1:
      return "Just pulled 30 SOMI from the Somnia Lootbox. #Somnia #Lootbox #Web3";
    case 2:
      return "Just pulled 50 SOMI from the Somnia Lootbox. #Somnia #Lootbox #Web3";
    case 3:
      return "Just pulled 75 SOMI from the Somnia Lootbox. #Somnia #Lootbox #Web3";
    case 4:
      return "Just pulled 200 SOMI from the Somnia Lootbox. #Somnia #Lootbox #Web3";
    case 5:
      return "Just pulled 750 Points for S5 from the Somnia Lootbox. #Somnia #Lootbox #Web3";
    case 6:
      return "Just pulled 1000 Points from the Somnia Lootbox. #Somnia #Lootbox #Web3";
    case 7:
      return "Just pulled 1500 Points from the Somnia Lootbox. #Somnia #Lootbox #Web3";
    case 8:
      return "Just pulled 1750 Points from the Somnia Lootbox. #Somnia #Lootbox #Web3";
    case 9:
      return "Just pulled 2000 Points from the Somnia Lootbox. #Somnia #Lootbox #Web3";
    default:
      return "Just opened the Somnia Lootbox. #Somnia #Lootbox #Web3";
  }
}

export default function LootboxPage() {
  const { appKit } = useReown() || {};
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const [mounted, setMounted] = useState(false);
  const [opening, setOpening] = useState(false);
  const [lastWin, setLastWin] = useState<string | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [rewardVisible, setRewardVisible] = useState(false);
  const [rewardDone, setRewardDone] = useState(false);
  const [showBurnModal, setShowBurnModal] = useState(false);
  const [showMixerModal, setShowMixerModal] = useState(false);
  const [showRewardsModal, setShowRewardsModal] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [mixCountInput, setMixCountInput] = useState("1");
  const [mixing, setMixing] = useState(false);
  const [mixError, setMixError] = useState<string | null>(null);
  const [awaitingSignature, setAwaitingSignature] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [chestDone, setChestDone] = useState(false);
  const [pendingItemType, setPendingItemType] = useState<number | null>(null);
  const [lastOpenTxHash, setLastOpenTxHash] = useState<`0x${string}` | null>(null);
  const [fireworksVisible, setFireworksVisible] = useState(false);
  const [accountLabel, setAccountLabel] = useState("Connect Wallet");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rewardRef = useRef<HTMLVideoElement | null>(null);
  const fireworksRef = useRef<HTMLVideoElement | null>(null);
  const accountBtnRef = useRef<HTMLButtonElement | null>(null);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);

  type Toast = {
    id: string;
    title: string;
    txHash?: `0x${string}`;
  };

  type RewardEntry = {
    id: string;
    chainId: number;
    lootbox: `0x${string}`;
    txHash: `0x${string}` | null;
    itemType: number; // 0..4 or 255
    token?: `0x${string}`;
    onchainId?: string;
    amount?: string;
    createdAt: number;
    claimed?: boolean;
  };
  const [rewardHistory, setRewardHistory] = useState<RewardEntry[]>([]);
  const [claimingRewardId, setClaimingRewardId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  function txUrl(hash: `0x${string}`) {
    if (!EXPLORER_TX_BASE) return null;
    return `${EXPLORER_TX_BASE}${hash}`;
  }

  function pushTxToast(title: string, txHash: `0x${string}`) {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((prev) => [{ id, title, txHash }, ...prev].slice(0, 4));
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 8000);
  }

  function dismissToast(id: string) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  useEffect(() => {
    setMounted(true);
  }, []);

  // Prevent SSR/CSR hydration mismatches: wallet connection state is restored only on client.
  const uiConnected = mounted && isConnected;
  const uiAddress = mounted ? address : undefined;

  const rewardMode = rewardVisible || rewardDone;
  const isWin = pendingItemType !== null;
  const rewardVideoSrc =
    pendingItemType !== null
      ? (PRIZES_BY_ITEM_TYPE[pendingItemType]?.videoSrc ?? "/assets/card01.webm")
      : null;
  const [rewardCanPlay, setRewardCanPlay] = useState(false);
  const [fireworksStartMs, setFireworksStartMs] = useState<number | null>(null);

  const { data: lootboxKeyBalances, refetch: refetchLootboxKeyBalances } = useReadContracts({
    allowFailure: true,
    contracts: uiAddress
      ? LOOTBOX_KEY_IDS.map((id) => ({
          address: LOOTBOX_KEYS,
          abi: keysAbi,
          functionName: "balanceOf",
          args: [uiAddress, id]
        }))
      : [],
    query: { enabled: !!uiAddress }
  });

  const { data: inputKeyBalances, refetch: refetchInputKeyBalances } = useReadContracts({
    allowFailure: true,
    contracts: uiAddress
      ? INPUT_KEY_IDS.map((id) => ({
          address: INPUT_KEYS,
          abi: keysAbi,
          functionName: "balanceOf",
          args: [uiAddress, id]
        }))
      : [],
    query: { enabled: !!uiAddress }
  });

  const { data: approvals, refetch: refetchApprovals } = useReadContracts({
    allowFailure: true,
    contracts: uiAddress
      ? [
          {
            address: INPUT_KEYS,
            abi: keysAbi,
            functionName: "isApprovedForAll",
            args: [uiAddress, MIXER]
          },
          {
            address: LOOTBOX_KEYS,
            abi: keysAbi,
            functionName: "isApprovedForAll",
            args: [uiAddress, LOOTBOX]
          }
        ]
      : [],
    query: { enabled: !!uiAddress }
  });

  const { writeContractAsync } = useWriteContract();

  const isLootboxConfigured = LOOTBOX !== "0x0000000000000000000000000000000000000000";
  const isMixerConfigured = MIXER !== "0x0000000000000000000000000000000000000000";
  const isInputKeysConfigured = INPUT_KEYS !== "0x0000000000000000000000000000000000000000";
  const isLootboxKeysConfigured = LOOTBOX_KEYS !== "0x0000000000000000000000000000000000000000";
  const isCorrectChain = chainId === somniaChain.id;

  const availableKeyIds = useMemo(() => {
    if (!lootboxKeyBalances) return [];
    const result: bigint[] = [];
    for (let i = 0; i < LOOTBOX_KEY_IDS.length; i++) {
      const entry = lootboxKeyBalances[i];
      const e = entry as unknown as { status?: string; result?: unknown } | undefined;
      if (!e || e.status !== "success" || e.result === undefined) continue;
      const bal = BigInt(e.result as bigint);
      if (bal > 0n) result.push(LOOTBOX_KEY_IDS[i]!);
    }
    return result;
  }, [lootboxKeyBalances]);

  const inputTotal = useMemo(() => {
    if (!inputKeyBalances) return 0n;
    return inputKeyBalances.reduce((acc, entry) => {
      const e = entry as unknown as { status?: string; result?: unknown } | undefined;
      if (!e || e.status !== "success" || e.result === undefined) return acc;
      return acc + BigInt(e.result as bigint);
    }, 0n);
  }, [inputKeyBalances]);

  const inputApproved = approvals?.[0]?.status === "success" ? Boolean(approvals[0].result) : false;
  const lootboxKeyApproved = approvals?.[1]?.status === "success" ? Boolean(approvals[1].result) : false;

  useEffect(() => {
    // no-op (keyId selection removed; we use first available key)
  }, [availableKeyIds]);

  const canOpen = useMemo(() => {
    return (
      uiConnected &&
      !!uiAddress &&
      !opening &&
      !awaitingSignature &&
      isLootboxConfigured &&
      isCorrectChain &&
      availableKeyIds.length > 0
    );
  }, [uiConnected, uiAddress, opening, awaitingSignature, isLootboxConfigured, isCorrectChain, availableKeyIds.length]);

  const keysDisplay = useMemo(() => {
    if (!lootboxKeyBalances) return "0";
    const sum = lootboxKeyBalances.reduce((acc, entry) => {
      const e = entry as unknown as { status?: string; result?: unknown } | undefined;
      if (!e || e.status !== "success" || e.result === undefined) return acc;
      return acc + BigInt(e.result as bigint);
    }, 0n);
    return sum.toString();
  }, [lootboxKeyBalances]);

  const inputKeysDisplay = useMemo(() => inputTotal.toString(), [inputTotal]);

  useEffect(() => {
    if (uiConnected && uiAddress) {
      setAccountLabel(`${uiAddress.slice(0, 6)}…${uiAddress.slice(-4)}`);
    } else {
      setAccountLabel("Connect Wallet");
      setOpening(false);
      setAwaitingSignature(false);
      setRewardVisible(false);
      setRewardDone(false);
      setLastWin(null);
      setShowBurnModal(false);
      setShowMixerModal(false);
      setMixing(false);
      setMixError(null);
      setOpenError(null);
      setChestDone(false);
      setPendingItemType(null);
      setShowRewardsModal(false);
      setAccountMenuOpen(false);
      setLastOpenTxHash(null);
      setRewardHistory([]);
      setFireworksVisible(false);
    }
  }, [uiConnected, uiAddress]);

  const rewardsStorageKey = useMemo(() => {
    if (!uiAddress) return null;
    return `lootboxes:rewards:${chainId}:${uiAddress.toLowerCase()}:${LOOTBOX.toLowerCase()}`;
  }, [uiAddress, chainId]);

  useEffect(() => {
    if (!rewardsStorageKey) return;
    try {
      const raw = window.localStorage.getItem(rewardsStorageKey);
      if (!raw) {
        setRewardHistory([]);
        return;
      }
      const parsed = JSON.parse(raw) as RewardEntry[];
      if (Array.isArray(parsed)) setRewardHistory(parsed);
    } catch {
      // ignore
    }
  }, [rewardsStorageKey]);

  // Optional: also load from Redis-backed API (so history follows user across devices).
  useEffect(() => {
    if (!ENABLE_REWARDS_REDIS) return;
    if (!address) return;
    if (!isConnected) return;
    if (!isLootboxConfigured) return;
    void (async () => {
      try {
        const qs = new URLSearchParams({
          address,
          chainId: String(chainId),
          lootbox: LOOTBOX
        });
        const res = await fetch(`/api/rewards?${qs.toString()}`, { method: "GET" });
        if (!res.ok) return;
        const data = (await res.json()) as { items?: RewardEntry[] };
        if (Array.isArray(data.items)) setRewardHistory(data.items);
      } catch {
        // ignore
      }
    })();
  }, [ENABLE_REWARDS_REDIS, address, isConnected, chainId, isLootboxConfigured]);

  useEffect(() => {
    if (!rewardsStorageKey) return;
    try {
      window.localStorage.setItem(rewardsStorageKey, JSON.stringify(rewardHistory.slice(0, 200)));
    } catch {
      // ignore
    }
  }, [rewardHistory, rewardsStorageKey]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      const btn = accountBtnRef.current;
      const menu = accountMenuRef.current;
      if (btn && btn.contains(t)) return;
      if (menu && menu.contains(t)) return;
      setAccountMenuOpen(false);
    }
    if (accountMenuOpen) document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [accountMenuOpen]);

  function beginOpenFlow() {
    if (!isConnected) {
      appKit?.open();
      return;
    }
    if (!address) return;
    setOpenError(null);
    setShowBurnModal(true);
  }

  function beginMixFlow() {
    if (!isConnected) {
      appKit?.open();
      return;
    }
    if (!address) return;
    setMixCountInput("1");
    setMixError(null);
    setShowMixerModal(true);
  }

  async function approveInputKeys() {
    if (!address) return;
    if (!isCorrectChain) {
      setMixError(`Wrong network. Switch wallet to chainId ${somniaChain.id}.`);
      return;
    }
    if (!isMixerConfigured || !isInputKeysConfigured) {
      setMixError("Mixer/Input keys are not configured.");
      return;
    }
    setMixError(null);
    setMixing(true);
    try {
      const txHash = await writeContractAsync({
        address: INPUT_KEYS,
        abi: keysAbi,
        functionName: "setApprovalForAll",
        args: [MIXER, true]
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash: txHash });
      pushTxToast("Approval confirmed", txHash);
      await refetchApprovals?.();
    } catch (e) {
      setMixError(e instanceof Error ? e.message : "Approval failed");
    } finally {
      setMixing(false);
    }
  }

  async function approveLootboxKeyForLootbox() {
    if (!address) return;
    if (!isCorrectChain) {
      setOpenError(`Wrong network. Switch wallet to chainId ${somniaChain.id}.`);
      return;
    }
    if (!isLootboxConfigured || !isLootboxKeysConfigured) {
      setOpenError("Lootbox/LootboxKey is not configured.");
      return;
    }
    setOpenError(null);
    try {
      const txHash = await writeContractAsync({
        address: LOOTBOX_KEYS,
        abi: keysAbi,
        functionName: "setApprovalForAll",
        args: [LOOTBOX, true]
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash: txHash });
      pushTxToast("Approval confirmed", txHash);
      await refetchApprovals?.();
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : "Approval failed");
    }
  }

  function adjustMixCount(delta: number) {
    const current = Number.parseInt(mixCountInput || "1", 10);
    const base = Number.isFinite(current) && current > 0 ? current : 1;
    const next = Math.max(1, base + delta);
    setMixCountInput(String(next));
  }

  function onMixCountChange(raw: string) {
    // Keep only digits to avoid negatives / scientific notation.
    const cleaned = raw.replace(/[^\d]/g, "");
    setMixCountInput(cleaned);
  }

  function normalizeMixCount() {
    const n = Number.parseInt(mixCountInput || "1", 10);
    setMixCountInput(String(Number.isFinite(n) && n > 0 ? n : 1));
  }

  function buildMixArgs(need: bigint, remaining: Map<bigint, bigint>) {
    const ids: bigint[] = [];
    const amts: bigint[] = [];
    let left = need;
    for (let i = 0; i < INPUT_KEY_IDS.length && left > 0n; i++) {
      const id = INPUT_KEY_IDS[i]!;
      const have = remaining.get(id) ?? 0n;
      if (have <= 0n) continue;
      const take = have > left ? left : have;
      ids.push(id);
      amts.push(take);
      remaining.set(id, have - take);
      left -= take;
    }
    if (left !== 0n) return null;
    return { ids, amts };
  }

  async function confirmMix() {
    if (!address) return;
    if (!isCorrectChain) {
      setMixError(`Wrong network. Switch wallet to chainId ${somniaChain.id}.`);
      return;
    }
    if (!isMixerConfigured || !isInputKeysConfigured || !isLootboxKeysConfigured) {
      setMixError("Mixer/Input keys/LootboxKey are not configured.");
      return;
    }
    const count = Number.parseInt(mixCountInput, 10);
    if (!Number.isFinite(count) || count <= 0) {
      setMixError("Enter a positive number.");
      return;
    }
    const totalNeed = MIX_REQUIRED_TOTAL * BigInt(count);
    if (inputTotal < totalNeed) {
      setMixError(`Not enough input keys. Need ${totalNeed.toString()} total, you have ${inputTotal.toString()}.`);
      return;
    }
    if (!inputApproved) {
      setMixError("Approve input keys for Mixer first.");
      return;
    }

    // Build a local remaining map from current balances
    const remaining = new Map<bigint, bigint>();
    for (let i = 0; i < INPUT_KEY_IDS.length; i++) {
      const id = INPUT_KEY_IDS[i]!;
      const entry = inputKeyBalances?.[i];
      const e = entry as unknown as { status?: string; result?: unknown } | undefined;
      const bal = e && e.status === "success" && e.result !== undefined ? BigInt(e.result as bigint) : 0n;
      remaining.set(id, bal);
    }

    setMixing(true);
    setMixError(null);
    try {
      for (let i = 0; i < count; i++) {
        const args = buildMixArgs(MIX_REQUIRED_TOTAL, remaining);
        if (!args) throw new Error("Failed to build mix args (balances changed).");
        const txHash = await writeContractAsync({
          address: MIXER,
          abi: mixerAbi,
          functionName: "mixERC1155",
          args: [MIX_RECIPE_ID, args.ids, args.amts]
        });
        if (publicClient) await publicClient.waitForTransactionReceipt({ hash: txHash });
        pushTxToast(`Mixer success (${i + 1}/${count})`, txHash);
      }
      await Promise.all([refetchInputKeyBalances?.(), refetchLootboxKeyBalances?.()]);
      setShowMixerModal(false);
    } catch (e) {
      setMixError(e instanceof Error ? e.message : "Mix failed");
    } finally {
      setMixing(false);
    }
  }

  const desiredLootboxKeysToCraft = useMemo(() => {
    const n = Number.parseInt(mixCountInput, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }, [mixCountInput]);

  const missingInputKeys = useMemo(() => {
    const need = MIX_REQUIRED_TOTAL * BigInt(desiredLootboxKeysToCraft);
    return inputTotal >= need ? 0n : need - inputTotal;
  }, [inputTotal, desiredLootboxKeysToCraft]);

  async function mintMissingInputKeys() {
    if (!address) return;
    if (!ENABLE_TEST_MINT) {
      setMixError("Test mint is disabled (set NEXT_PUBLIC_ENABLE_TEST_MINT=true).");
      return;
    }
    if (!isCorrectChain) {
      setMixError(`Wrong network. Switch wallet to chainId ${somniaChain.id}.`);
      return;
    }
    if (!isInputKeysConfigured) {
      setMixError("Input keys address is not configured.");
      return;
    }
    if (missingInputKeys <= 0n) return;

    setMixing(true);
    setMixError(null);
    try {
      // Mint missing amount to id=1 (simplest UX for testnet)
      const txHash = await writeContractAsync({
        address: INPUT_KEYS,
        abi: keysAbi,
        functionName: "mintBatchTo",
        args: [address, [1n], [missingInputKeys]]
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash: txHash });
      pushTxToast("Keys minted", txHash);
      await refetchInputKeyBalances?.();
    } catch (e) {
      setMixError(e instanceof Error ? e.message : "Mint failed");
    } finally {
      setMixing(false);
    }
  }

  async function openOnchain(keyId: bigint) {
    if (!address) return;
    if (!publicClient) {
      setOpenError("No public client available");
      setOpening(false);
      return;
    }
    if (!isLootboxConfigured) {
      setOpenError("Set NEXT_PUBLIC_LOOTBOX_ADDRESS to enable opening.");
      setOpening(false);
      return;
    }
    if (!isCorrectChain) {
      setOpenError(`Wrong network. Switch wallet to chainId ${somniaChain.id}.`);
      setOpening(false);
      return;
    }

    setAwaitingSignature(true);
    try {
      // IMPORTANT UX: start chest animation only after the user successfully signs/sends the tx.
      const hash = await writeContractAsync({
        address: LOOTBOX,
        abi: lootboxAbi,
        functionName: "openWithKey",
        args: [keyId]
      });
      setAwaitingSignature(false);
      setLastOpenTxHash(hash);

      // tx submitted -> now start opening UI
      setOpening(true);
      setLastWin("Transaction sent. Opening…");
      setRewardVisible(false);
      setRewardDone(false);
      setVideoReady(false);
      setOpenError(null);
      setChestDone(false);
      setPendingItemType(null);

      if (rewardRef.current) {
        rewardRef.current.pause();
        rewardRef.current.currentTime = 0;
      }
      if (videoRef.current) {
        try {
          videoRef.current.pause();
          videoRef.current.currentTime = 0;
          videoRef.current.load();
        } catch {
          // noop
        }
      }

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      // If the tx reverted, stop the UI immediately (no reward will be emitted).
      // This can happen if a prize path fails (e.g. WL mint) or if the contract is out of funds.
      if ((receipt as unknown as { status?: string }).status === "reverted") {
        setOpenError("Transaction reverted. No reward was issued.");
        setOpening(false);
        setChestDone(false);
        setPendingItemType(null);
        setFireworksVisible(false);
        setRewardVisible(false);
        setRewardDone(false);
        return;
      }
      pushTxToast("Lootbox opened", hash);
      const fromBlock = receipt.blockNumber;

      // If ItemAwarded is emitted in the same tx, decode it.
      try {
        const parsed = parseEventLogs({ abi: lootboxAbi, logs: receipt.logs });
        const awarded = parsed.find(
          (e) => e.eventName === "ItemAwarded" && (e.args as { user?: string }).user?.toLowerCase() === address.toLowerCase()
        );
        if (awarded) {
          const args = awarded.args as { itemType: number; token: `0x${string}`; id: bigint; amount: bigint };
          const itemType = Number(args.itemType);
          setPendingItemType(itemType);
          setRewardHistory((prev) => [
            {
              id: `${Date.now()}-${hash}`,
              chainId,
              lootbox: LOOTBOX,
              txHash: hash,
              itemType,
              token: args.token,
              onchainId: (args.id ?? 0n).toString(),
              amount: (args.amount ?? 0n).toString(),
              createdAt: Date.now(),
              claimed: false
            },
            ...prev
          ]);
          if (ENABLE_REWARDS_REDIS) {
            void fetch("/api/rewards", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ address, chainId, lootbox: LOOTBOX, txHash: hash })
            });
          }
          return;
        }
      } catch {
        // ignore; we'll poll logs below
      }

      // Async path: poll for ItemAwarded(user) in later txs.
      const deadlineMs = Date.now() + 2 * 60_000;
      while (Date.now() < deadlineMs) {
        const logs = await publicClient.getLogs({
          address: LOOTBOX,
          event: itemAwardedEvent,
          args: { user: address },
          fromBlock
        });
        if (logs.length) {
          const decoded = parseEventLogs({ abi: lootboxAbi, logs });
          const first = decoded.find((e) => e.eventName === "ItemAwarded");
          if (first) {
            const args = first.args as { itemType: number; token: `0x${string}`; id: bigint; amount: bigint };
            const itemType = Number(args.itemType);
            setPendingItemType(itemType);
            setRewardHistory((prev) => [
              {
                id: `${Date.now()}-${hash}`,
                chainId,
                lootbox: LOOTBOX,
                txHash: hash,
                itemType,
                token: args.token,
                onchainId: (args.id ?? 0n).toString(),
                amount: (args.amount ?? 0n).toString(),
                createdAt: Date.now()
              },
              ...prev
            ]);
            if (ENABLE_REWARDS_REDIS) {
              void fetch("/api/rewards", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ address, chainId, lootbox: LOOTBOX, txHash: hash })
              });
            }
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 1500));
      }

      // Fallback: show "no reward" message instead of hanging forever.
      setPendingItemType(255);
      setOpenError(null);
      setRewardHistory((prev) => [
        {
          id: `${Date.now()}-${hash}`,
          chainId,
          lootbox: LOOTBOX,
          txHash: hash,
          itemType: 255,
          createdAt: Date.now()
        },
        ...prev
      ]);
      if (ENABLE_REWARDS_REDIS) {
        void fetch("/api/rewards", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address, chainId, lootbox: LOOTBOX, txHash: hash })
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Transaction failed";
      setOpenError(msg);
      setOpening(false);
      setAwaitingSignature(false);
    }
  }

  function confirmBurn() {
    const keyId = availableKeyIds[0] ?? null;
    if (!keyId) {
      if (typeof window !== "undefined") window.alert("No keys available");
      return;
    }
    if (!lootboxKeyApproved) {
      if (typeof window !== "undefined") window.alert("Approve LootboxKey for the Lootbox contract first");
      return;
    }

    // Lock UX while wallet signature dialog is open.
    setAwaitingSignature(true);
    setShowBurnModal(false);
    setOpenError(null);
    // openOnchain will start animation after tx is signed/sent
    void openOnchain(keyId);
  }

  useEffect(() => {
    if (opening && videoRef.current) {
      if (videoReady) {
        try {
          videoRef.current.currentTime = 0;
          const playPromise = videoRef.current.play();
          if (playPromise && typeof playPromise.then === "function") {
            playPromise.catch(() => {});
          }
        } catch (e) {
          // swallow in demo
        }
      }
    }
  }, [opening, videoReady]);

  useEffect(() => {
    if (!opening && videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
  }, [opening]);

  // Ensure reward video shows as soon as reward is revealed, even if chest video timing differs
  useEffect(() => {
    if (rewardVisible && rewardRef.current) {
      try {
        rewardRef.current.currentTime = 0;
        const playPromise = rewardRef.current.play();
        if (playPromise && typeof playPromise.then === "function") {
          playPromise.catch(() => {});
        }
      } catch (e) {
        // noop in demo
      }
    }
  }, [rewardVisible]);

  // Reveal reward only when BOTH: chest animation finished AND on-chain result is known.
  useEffect(() => {
    if (!opening) return;
    if (!chestDone) return;
    if (pendingItemType === null) return;

    // Always-win loot table: show fireworks video before reward card for every open.
    setRewardVisible(false);
    setRewardDone(false);
    setRewardCanPlay(false);
    setFireworksStartMs(Date.now());
    setFireworksVisible(true);
  }, [opening, chestDone, pendingItemType]);

  // Win UX: `final.webm` starts first, and the reward card appears 1s later (no pause).
  useEffect(() => {
    if (!fireworksVisible) return;
    if (!isWin) return;
    if (rewardVisible) return;
    if (!fireworksStartMs) return;

    const elapsed = Date.now() - fireworksStartMs;
    const delay = Math.max(0, 1000 - elapsed);
    const t = window.setTimeout(() => {
      // If the reward is still not ready, we will still show the card container;
      // the reward video will start instantly once it becomes playable.
      setRewardVisible(true);
    }, delay);
    return () => window.clearTimeout(t);
  }, [fireworksVisible, isWin, rewardVisible, fireworksStartMs]);

  useEffect(() => {
    if (!fireworksVisible || !fireworksRef.current) return;
    try {
      fireworksRef.current.currentTime = 0;
      fireworksRef.current.play().catch(() => {});
    } catch {
      // noop
    }
  }, [fireworksVisible]);

  async function onOpen() {
    beginOpenFlow();
  }

  function shareOnX() {
    const text = buildShareText(pendingItemType ?? 0);
    const url = typeof window !== "undefined" ? window.location.href : "https://quests.somnia.network";
    const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
    if (typeof window !== "undefined") {
      window.open(tweetUrl, "_blank", "noopener,noreferrer");
      // Close the reward UI completely after sharing (do not re-show on other UI actions).
      setRewardVisible(false);
      setRewardDone(false);
      setPendingItemType(null);
      setLastWin(null);
      setChestDone(false);
      setOpening(false);
      if (rewardRef.current) {
        try {
          rewardRef.current.pause();
          rewardRef.current.currentTime = 0;
        } catch {
          // noop
        }
      }
    }
  }

  async function claimReward(entry: RewardEntry) {
    if (!address) return;
    if (!publicClient) return;
    if (!isCorrectChain) return;
    try {
      setClaimingRewardId(entry.id);
      if (entry.itemType === 1 || entry.itemType === 2 || entry.itemType === 3 || entry.itemType === 4) {
        const isNative = !entry.token || entry.token === "0x0000000000000000000000000000000000000000";
        const txHash = isNative
          ? await writeContractAsync({
              address: LOOTBOX,
              abi: lootboxClaimsAbi,
              functionName: "claimNative",
              args: []
            })
          : await writeContractAsync({
              address: LOOTBOX,
              abi: lootboxClaimsAbi,
              functionName: "claimErc20",
              args: [entry.token as `0x${string}`]
            });
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        pushTxToast("Reward claimed", txHash);
        setRewardHistory((prev) => {
          // For native: claimNative empties all native claimables; for ERC20: empties by token.
          if (isNative) {
            return prev.map((r) =>
              (r.itemType === 1 || r.itemType === 2 || r.itemType === 3 || r.itemType === 4) &&
              (!r.token || r.token === "0x0000000000000000000000000000000000000000")
                ? { ...r, claimed: true }
                : r
            );
          }
          return prev.map((r) =>
            (r.itemType === 1 || r.itemType === 2 || r.itemType === 3 || r.itemType === 4) &&
            r.token?.toLowerCase() === entry.token?.toLowerCase()
              ? { ...r, claimed: true }
              : r
          );
        });
      }
      if (entry.itemType === 0) {
        if (!entry.token || entry.token === "0x0000000000000000000000000000000000000000") return;
        const txHash = await writeContractAsync({
          address: LOOTBOX,
          abi: lootboxClaimsAbi,
          functionName: "claimErc721",
          args: [entry.token, 1n]
        });
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        pushTxToast("Reward claimed", txHash);
        setRewardHistory((prev) => prev.map((r) => (r.id === entry.id ? { ...r, claimed: true } : r)));
      }
    } catch {
      // noop (wallet will show the error)
    } finally {
      setClaimingRewardId(null);
    }
  }

  return (
    <div className={`page ${rewardMode ? "reward-mode" : ""}`}>
      <div className="bg-orb" />
      <div className="grid-lines" />
      <div className="stars" />
      <div className="aurora-hero">
        <Aurora colorStops={["#3ECCEE", "#4845F6", "#E70D6B"]} amplitude={1.2} blend={0.65} />
      </div>

      <div className={`reward-backdrop ${rewardMode ? "is-visible" : ""}`} />

      {fireworksVisible && isWin && (
        <div className="fireworks-overlay" aria-hidden="true">
          <video
            ref={fireworksRef}
            className="fireworks-video"
            src="/assets/final.webm"
            playsInline
            muted
            preload="auto"
            loop={false}
            autoPlay
            onEnded={() => {
              setFireworksVisible(false);
              setRewardVisible(true);
            }}
          />
        </div>
      )}

      {/* Preload the reward video while `final.webm` is playing */}
      {fireworksVisible && isWin && rewardVideoSrc && !rewardCanPlay && (
        <video
          src={rewardVideoSrc}
          playsInline
          muted
          preload="auto"
          style={{ display: "none" }}
          onCanPlay={() => setRewardCanPlay(true)}
        />
      )}

      <header className="container nav">
        <div className="brand">
          <img src="/assets/somnia-logo.svg" alt="Somnia" width={28} height={28} />
          <div className="brand-text">
            <span className="eyebrow">Somnia</span>
            <strong>Odyssey Lootbox</strong>
          </div>
        </div>
        <div className="nav-actions">
          <button className="btn ghost" onClick={beginMixFlow} disabled={!isConnected || !isCorrectChain || !isMixerConfigured}>
            Mixer
          </button>
          <div style={{ position: "relative" }}>
            <button
              ref={accountBtnRef}
              className="btn ghost"
              onClick={() => {
                if (!uiConnected) {
                  appKit?.open();
                  return;
                }
                setAccountMenuOpen((v) => !v);
              }}
            >
              <span className={`key-chip ${uiConnected ? "is-visible" : "is-hidden"}`} suppressHydrationWarning>
                {uiConnected ? `${keysDisplay} lootbox keys` : ""}
              </span>
              <span className={`key-chip ${uiConnected ? "is-visible" : "is-hidden"}`} style={{ marginLeft: 8 }} suppressHydrationWarning>
                {uiConnected ? `${inputKeysDisplay} input keys` : ""}
              </span>
              <span className="account-label" suppressHydrationWarning>{accountLabel}</span>
            </button>
            {uiConnected && accountMenuOpen && (
              <div
                ref={accountMenuRef}
                className="modal-card"
                style={{
                  position: "absolute",
                  top: "calc(100% + 10px)",
                  right: 0,
                  width: 240,
                  padding: 12,
                  zIndex: 50
                }}
                role="menu"
              >
                <button
                  className="btn ghost"
                  style={{ width: "100%", justifyContent: "center" }}
                  onClick={() => {
                    setAccountMenuOpen(false);
                    setShowRewardsModal(true);
                  }}
                >
                  Rewards
                </button>
                <button
                  className="btn ghost"
                  style={{ width: "100%", justifyContent: "center", marginTop: 10 }}
                  onClick={() => {
                    setAccountMenuOpen(false);
                    disconnect();
                  }}
                >
                  Disconnect
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="container hero-stack tight">
        <section className="hero-center">
          <div className="microcopy">
            <h1>Open the cosmic vault</h1>
            <p className="lede-short">One pull · One moment · Built on a 1M TPS L1</p>
          </div>

          <div className="chest-stage">
            <div className="stage-aurora" />
            <div className="stage-rings" />
            <div className="stage-particles" />

            <div
              className={`chest-hit ${opening ? "is-opening" : "is-idle"} ${rewardVisible || rewardDone ? "is-rewarding" : ""}`}
              role="button"
              tabIndex={0}
              aria-pressed={opening}
              aria-label="Open lootbox"
              onClick={() => {
                if (!opening && !awaitingSignature && !rewardVisible && !rewardDone) onOpen();
              }}
              onKeyDown={(e) => {
                if (!opening && !awaitingSignature && !rewardVisible && !rewardDone && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  onOpen();
                }
              }}
            >
              <img
                src="/assets/lootbox.png"
                alt="Closed lootbox"
                className={`chest-still ${opening ? "is-hidden" : ""}`}
                aria-hidden={opening}
                draggable={false}
              />
              <video
                ref={videoRef}
                className={`chest-video ${opening && videoReady ? "is-visible" : ""}`}
                src="/assets/lootbox.webm"
                playsInline
                muted
                preload="auto"
                loop={false}
                onLoadedData={() => {
                  setVideoReady(true);
                  if (videoRef.current) {
                    videoRef.current.currentTime = 0;
                  }
                }}
                onLoadedMetadata={() => {
                  setVideoReady(true);
                  if (videoRef.current) {
                    videoRef.current.currentTime = 0;
                  }
                }}
                onEnded={() => {
                  // Only proceed to reward after chest video fully played
                  setChestDone(true);
                  setRewardDone(false);
                  if (videoRef.current) {
                    videoRef.current.pause();
                  }
                }}
                onError={() => setVideoReady(false)}
              />
              <div className="chest-shine" />
            </div>
          </div>

          <div className="cta-stack">
            <button className="btn primary xl" disabled={!canOpen} onClick={onOpen}>
              {awaitingSignature ? "Confirm in wallet…" : opening ? "Rolling…" : "Open the Somnia Lootbox"}
            </button>
            {openError && <p className="muted" style={{ marginTop: 12 }}>{openError}</p>}
            {!isLootboxConfigured && <p className="muted" style={{ marginTop: 12 }}>Set NEXT_PUBLIC_LOOTBOX_ADDRESS to enable opening.</p>}
            {uiConnected && !isCorrectChain && <p className="muted" style={{ marginTop: 12 }}>Wrong network. Switch wallet to Somnia Mainnet.</p>}
          </div>
        </section>
      </main>

      {rewardMode && (
        <div className={`reward-tilt ${rewardMode ? "is-visible" : ""}`}>
          <TiltedCard
            imageSrc=""
            containerHeight="100%"
            containerWidth="100%"
            imageHeight="100%"
            imageWidth="100%"
            scaleOnHover={1.04}
            rotateAmplitude={10}
            showMobileWarning={false}
            showTooltip={false}
            mediaContent={
              <video
                ref={rewardRef}
                className="reward-video"
                src={rewardVideoSrc ?? "/assets/card01.webm"}
                playsInline
                muted
                preload="auto"
                loop={false}
                onCanPlay={() => {
                  setRewardCanPlay(true);
                  if (rewardVisible && rewardRef.current) {
                    rewardRef.current.play().catch(() => {});
                  }
                }}
                onLoadedData={() => {
                  if (rewardRef.current) {
                    rewardRef.current.currentTime = 0;
                    // Playback is controlled by the `rewardVisible` effect to avoid double-start/replays.
                    if (!rewardVisible) rewardRef.current.pause();
                  }
                }}
                onEnded={() => {
                  setOpening(false);
                  setRewardDone(true);
                  const itemType = pendingItemType ?? 0;
                  const title = formatPrizeTitle(itemType);
                  setLastWin(`Reward received: ${title} · keys burned: 1`);
                }}
              />
            }
          />
          {rewardDone && (
            <div className="reward-dismiss">
              <button className="btn ghost" onClick={shareOnX}>
                Share on X
              </button>
            </div>
          )}
        </div>
      )}

      {showBurnModal && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card">
            <div className="modal-head">
              <p className="eyebrow">Lootbox</p>
              <h3>Open the lootbox?</h3>
              <p className="modal-sub">If you have a Lootbox Key, you can open once.</p>
            </div>
            {!lootboxKeyApproved && (
              <div className="modal-sub" style={{ marginBottom: 12 }}>
                <p style={{ margin: 0, opacity: 0.85 }}>Approval required: allow the Lootbox contract to burn your LootboxKey.</p>
                <button className="btn ghost" onClick={approveLootboxKeyForLootbox} disabled={opening}>
                  Approve LootboxKey
                </button>
              </div>
            )}
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setShowBurnModal(false)} disabled={opening || awaitingSignature}>
                Cancel
              </button>
              <button className="btn primary" onClick={confirmBurn} disabled={opening || awaitingSignature || !availableKeyIds.length || !lootboxKeyApproved}>
                {awaitingSignature ? "Confirm in wallet…" : "Open"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showMixerModal && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card">
            <div className="modal-head">
              <p className="eyebrow">Mixer</p>
              <h3>Convert keys into Lootbox Keys</h3>
              <p className="modal-sub">
                Requires <b>{MIX_REQUIRED_TOTAL.toString()}</b> input keys (ids {INPUT_KEY_IDS[0]?.toString()}–{INPUT_KEY_IDS.at(-1)?.toString()}) per LootboxKey.
              </p>
              <p className="modal-sub">You have <b>{inputTotal.toString()}</b> input keys total.</p>
              <p className="modal-sub" style={{ opacity: 0.75 }}>
                Reading input keys from <code>{INPUT_KEYS}</code>
              </p>
            </div>

            {!inputApproved && (
              <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
                <button className="btn ghost" onClick={approveInputKeys} disabled={mixing}>
                  Approve input → Mixer
                </button>
              </div>
            )}

            <label className="input-label" htmlFor="mix-count">How many Lootbox Keys to craft?</label>
            <div className="input-row stepper">
              <button className="btn ghost step-btn" type="button" onClick={() => adjustMixCount(-1)} disabled={mixing}>
                −
              </button>
              <input
                id="mix-count"
                type="number"
                min={1}
                value={mixCountInput}
                inputMode="numeric"
                pattern="[0-9]*"
                onKeyDown={(e) => {
                  if (e.key === "-" || e.key === "+" || e.key.toLowerCase() === "e") e.preventDefault();
                }}
                onChange={(e) => onMixCountChange(e.target.value)}
                onBlur={normalizeMixCount}
                className="neo-input"
              />
              <button className="btn ghost step-btn" type="button" onClick={() => adjustMixCount(1)} disabled={mixing}>
                +
              </button>
            </div>

            {ENABLE_TEST_MINT && missingInputKeys > 0n && (
              <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
                <button className="btn ghost" onClick={mintMissingInputKeys} disabled={mixing}>
                  Mint missing keys (+{missingInputKeys.toString()})
                </button>
              </div>
            )}

            {mixError && <p className="modal-sub" style={{ marginTop: 10, color: "rgba(255,255,255,0.85)" }}>{mixError}</p>}

            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setShowMixerModal(false)} disabled={mixing}>Cancel</button>
              <button className="btn primary" onClick={confirmMix} disabled={mixing || !inputApproved}>
                {mixing ? "Mixing…" : "Mix"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showRewardsModal && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card">
            <div className="modal-head">
              <p className="eyebrow">Rewards</p>
              <h3>Your lootbox results</h3>
              <p className="modal-sub">Saved locally for this wallet + network.</p>
            </div>

            {rewardHistory.length === 0 ? (
              <p className="modal-sub">No rewards yet. Open a lootbox to see results here.</p>
            ) : (
              <div style={{ display: "grid", gap: 10, marginTop: 10, maxHeight: 360, overflow: "auto" }}>
                {rewardHistory.map((r) => {
                  const title = formatPrizeTitle(r.itemType);
                  const isNoWin = r.itemType === 255;
                  const claimable =
                    r.itemType === 0 ||
                    r.itemType === 1 ||
                    r.itemType === 2 ||
                    r.itemType === 3 ||
                    r.itemType === 4;
                  const isClaimed = !!r.claimed;
                  return (
                    <div
                      key={r.id}
                      style={{
                        border: "1px solid rgba(255,255,255,0.12)",
                        borderRadius: 14,
                        padding: 12
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                        <div>
                          <div style={{ fontWeight: 650 }}>{title}</div>
                          <div style={{ opacity: 0.75, fontSize: 12, marginTop: 4 }}>
                            {new Date(r.createdAt).toLocaleString()}
                          </div>
                          {r.txHash && (
                            <div style={{ opacity: 0.75, fontSize: 12, marginTop: 4 }}>
                              Tx: <code>{r.txHash.slice(0, 10)}…{r.txHash.slice(-8)}</code>
                            </div>
                          )}
                          {!isNoWin && r.amount && r.amount !== "0" && (
                            <div style={{ opacity: 0.8, fontSize: 12, marginTop: 4 }}>
                              Amount: <code>{r.amount}</code>
                            </div>
                          )}
                        </div>
                        {claimable && !isNoWin && (
                          <button className="btn ghost" onClick={() => claimReward(r)} disabled={isClaimed || claimingRewardId === r.id}>
                            {isClaimed ? "Claimed" : claimingRewardId === r.id ? "Claiming…" : "Claim"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setShowRewardsModal(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="corner-icons">
        <a className="corner-icon" href="https://x.com/Somnia_Network" target="_blank" rel="noreferrer" aria-label="Twitter">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 4.75 10.9 12 5 19.25h2.4L12.3 14l3.9 5.25h2.8L13.8 12l5.1-7.25H16.5L12.9 9.5 9.2 4.75z" fill="currentColor" />
          </svg>
        </a>
        <a className="corner-icon" href="https://discord.gg/somnia" target="_blank" rel="noreferrer" aria-label="Discord">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7.3 6c1.9-.5 3.5-.5 5.4 0l.3.1c.6-.5 1.4-.9 2.3-1.1.5-.1 1 .3 1.1.8.5 1.6.8 3.2.9 4.8v4.5c0 .6-.3 1.1-.8 1.4-1.1.7-2.3 1.2-3.5 1.4-.3.1-.6 0-.8-.2l-.8-.8c-.5.1-1 .1-1.5.1-.5 0-1 0-1.5-.1l-.8.8c-.2.2-.5.3-.8.2-1.3-.2-2.4-.7-3.5-1.4-.5-.3-.8-.8-.8-1.4v-4.5c.1-1.6.4-3.2.9-4.8.1-.5.7-.9 1.2-.8.9.2 1.7.5 2.3 1.1zm.4 3.8c-.7 0-1.2.7-1.2 1.5s.5 1.5 1.2 1.5 1.3-.7 1.3-1.5-.6-1.5-1.3-1.5zm8.6 0c-.7 0-1.2.7-1.2 1.5s.5 1.5 1.2 1.5 1.3-.7 1.3-1.5-.6-1.5-1.3-1.5z" fill="currentColor" />
          </svg>
        </a>
        <a className="corner-icon" href="https://browser.somnia.network/" target="_blank" rel="noreferrer" aria-label="Website">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3.25a8.75 8.75 0 1 0 0 17.5 8.75 8.75 0 0 0 0-17.5zM12 4.8c1 .8 1.8 2.4 2 4.2h-4c.2-1.8 1-3.4 2-4.2zm-3.4 1c-.7.8-1.2 2-1.4 3.2H5.1a7.26 7.26 0 0 1 3.5-3.2zm-3.5 4.7h2c0 1.1.2 2.1.5 3h-2a7.22 7.22 0 0 1-.5-3zm.6 4.5h2c.3 1 .7 1.9 1.3 2.7a7.28 7.28 0 0 1-3.3-2.7zm5.3 3c-.7-.7-1.4-1.8-1.8-3h3.6c-.4 1.2-1.1 2.3-1.8 3zm2.4-.3c.6-.8 1-1.7 1.3-2.7h2a7.28 7.28 0 0 1-3.3 2.7zm3.8-4.2h-2c.3-.9.5-1.9.5-3h2a7.22 7.22 0 0 1-.5 3zm-.5-4.5h-2c-.2-1.2-.7-2.4-1.4-3.2a7.26 7.26 0 0 1 3.4 3.2z" fill="currentColor" />
          </svg>
        </a>
      </div>

      {toasts.length > 0 && (
        <div className="toast-stack" aria-live="polite" aria-relevant="additions removals">
          {toasts.map((t) => {
            const href = t.txHash ? txUrl(t.txHash) : null;
            return (
              <div className="toast" key={t.id}>
                <div className="toast-row">
                  <div>
                    <div className="toast-title">{t.title}</div>
                    {t.txHash && (
                      <div className="toast-sub">
                        Tx:{" "}
                        {href ? (
                          <a className="toast-link" href={href} target="_blank" rel="noreferrer">
                            {t.txHash.slice(0, 10)}…{t.txHash.slice(-8)}
                          </a>
                        ) : (
                          <code>{t.txHash.slice(0, 10)}…{t.txHash.slice(-8)}</code>
                        )}
                      </div>
                    )}
                  </div>
                  <button className="toast-close" onClick={() => dismissToast(t.id)} aria-label="Close notification">
                    ✕
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}








