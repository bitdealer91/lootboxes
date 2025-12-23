"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, useChainId, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import { parseAbi, parseAbiItem, parseEventLogs } from "viem";
import { useReown } from "../providers/AppKitProvider";
import { somniaChain } from "../providers/chains";
import { formatPrizeTitle } from "../lootbox/prizes";

const INPUT_KEYS = (process.env.NEXT_PUBLIC_TEST_INPUT_KEYS_ADDRESS || "0x0000000000000000000000000000000000000000") as `0x${string}`;
const MIXER = (process.env.NEXT_PUBLIC_MIXER_ADDRESS || "0x0000000000000000000000000000000000000000") as `0x${string}`;
const LOOTBOX_KEY = (process.env.NEXT_PUBLIC_LOOTBOX_KEY_ADDRESS || "0x0000000000000000000000000000000000000000") as `0x${string}`;
const LOOTBOX = (process.env.NEXT_PUBLIC_LOOTBOX_ADDRESS || "0x0000000000000000000000000000000000000000") as `0x${string}`;
const RECIPE_ID = BigInt(process.env.NEXT_PUBLIC_RECIPE_ID || "1");

const IDS = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n];

const erc1155Abi = parseAbi([
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])",
  "function setApprovalForAll(address operator, bool approved) external",
  "function isApprovedForAll(address account, address operator) view returns (bool)",
  // TestKeys1155 faucet
  "function mintBatchTo(address to, uint256[] ids, uint256[] amounts) external"
]);

const mixerAbi = parseAbi(["function mixERC1155(uint256 recipeId, uint256[] ids, uint256[] amounts) external"]);

const lootboxAbi = parseAbi([
  "function openWithKey(uint256 keyId) external",
  "event ItemAwarded(address indexed user, uint8 itemType, address token, uint256 id, uint256 amount)"
]);

const itemAwardedEvent = parseAbiItem(
  "event ItemAwarded(address indexed user, uint8 itemType, address token, uint256 id, uint256 amount)"
);

export default function TestnetFlowPage() {
  const { appKit } = useReown() || {};
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [status, setStatus] = useState<string>("");
  const [lastReward, setLastReward] = useState<string>("");

  const isConfigured =
    INPUT_KEYS !== "0x0000000000000000000000000000000000000000" &&
    MIXER !== "0x0000000000000000000000000000000000000000" &&
    LOOTBOX_KEY !== "0x0000000000000000000000000000000000000000" &&
    LOOTBOX !== "0x0000000000000000000000000000000000000000";

  const isCorrectChain = chainId === somniaChain.id;

  const { data: balances } = useReadContracts({
    allowFailure: true,
    contracts:
      address && INPUT_KEYS !== "0x0000000000000000000000000000000000000000"
        ? IDS.map((id) => ({
            address: INPUT_KEYS,
            abi: erc1155Abi,
            functionName: "balanceOf",
            args: [address, id]
          }))
        : [],
    query: { enabled: !!address }
  });

  const inputTotal = useMemo(() => {
    if (!balances) return 0n;
    return balances.reduce((acc, entry) => {
      const e = entry as unknown as { status?: string; result?: unknown } | undefined;
      if (!e || e.status !== "success" || e.result === undefined) return acc;
      return acc + BigInt(e.result as bigint);
    }, 0n);
  }, [balances]);

  const { data: approvals } = useReadContracts({
    allowFailure: true,
    contracts: address
      ? [
          {
            address: INPUT_KEYS,
            abi: erc1155Abi,
            functionName: "isApprovedForAll",
            args: [address, MIXER]
          },
          {
            address: LOOTBOX_KEY,
            abi: erc1155Abi,
            functionName: "isApprovedForAll",
            args: [address, LOOTBOX]
          }
        ]
      : [],
    query: { enabled: !!address && isConfigured }
  });

  const inputApproved = approvals?.[0]?.status === "success" ? Boolean(approvals[0].result) : false;
  const lootboxKeyApproved = approvals?.[1]?.status === "success" ? Boolean(approvals[1].result) : false;

  async function mintTestKeys() {
    if (!address) return;
    if (!isCorrectChain) return setStatus(`Switch network to chainId ${somniaChain.id}`);
    setStatus("Minting test keys (100x id=1)…");
    await writeContractAsync({
      address: INPUT_KEYS,
      abi: erc1155Abi,
      functionName: "mintBatchTo",
      args: [address, [1n], [100n]]
    });
    setStatus("Mint tx sent. Wait for confirmation, then balances will refresh.");
  }

  async function approveInputToMixer() {
    if (!address) return;
    if (!isCorrectChain) return setStatus(`Switch network to chainId ${somniaChain.id}`);
    setStatus("Approving input keys for Mixer…");
    await writeContractAsync({
      address: INPUT_KEYS,
      abi: erc1155Abi,
      functionName: "setApprovalForAll",
      args: [MIXER, true]
    });
    setStatus("Approval tx sent.");
  }

  async function mix100to1() {
    if (!address) return;
    if (!isCorrectChain) return setStatus(`Switch network to chainId ${somniaChain.id}`);
    if (inputTotal < 100n) return setStatus("Need 100 input keys total (ids 1..8). Click Mint first.");

    // simplest: use id=1 amount=100 (works after mintTestKeys)
    setStatus("Mixing 100 keys → 1 lootbox key…");
    await writeContractAsync({
      address: MIXER,
      abi: mixerAbi,
      functionName: "mixERC1155",
      args: [RECIPE_ID, [1n], [100n]]
    });
    setStatus("Mix tx sent.");
  }

  async function approveLootboxKey() {
    if (!address) return;
    if (!isCorrectChain) return setStatus(`Switch network to chainId ${somniaChain.id}`);
    setStatus("Approving lootbox key for Lootbox…");
    await writeContractAsync({
      address: LOOTBOX_KEY,
      abi: erc1155Abi,
      functionName: "setApprovalForAll",
      args: [LOOTBOX, true]
    });
    setStatus("Approval tx sent.");
  }

  async function openLootbox() {
    if (!address) return;
    if (!publicClient) return;
    if (!isCorrectChain) return setStatus(`Switch network to chainId ${somniaChain.id}`);

    setStatus("Opening lootbox…");
    const hash = await writeContractAsync({
      address: LOOTBOX,
      abi: lootboxAbi,
      functionName: "openWithKey",
      args: [1n]
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    // Immediate path: TestLootboxInstant emits ItemAwarded in same tx
    const parsed = parseEventLogs({ abi: lootboxAbi, logs: receipt.logs });
    const awarded = parsed.find((e) => e.eventName === "ItemAwarded");
    if (awarded) {
      const args = awarded.args as { itemType: number };
      const title = formatPrizeTitle(Number(args.itemType));
      setLastReward(title);
      setStatus(`Awarded: ${title}`);
      return;
    }

    // fallback: poll logs (if you switch to async lootbox later)
    const logs = await publicClient.getLogs({
      address: LOOTBOX,
      event: itemAwardedEvent,
      args: { user: address },
      fromBlock: receipt.blockNumber
    });
    if (logs.length) {
      const decoded = parseEventLogs({ abi: lootboxAbi, logs });
      const first = decoded.find((e) => e.eventName === "ItemAwarded");
      if (first) {
        const args = first.args as { itemType: number };
        const title = formatPrizeTitle(Number(args.itemType));
        setLastReward(title);
        setStatus(`Awarded: ${title}`);
      }
    }
  }

  useEffect(() => {
    if (!isConnected) {
      setStatus("");
      setLastReward("");
    }
  }, [isConnected]);

  return (
    <div style={{ padding: 24, maxWidth: 820, margin: "0 auto" }}>
      <h2 style={{ fontSize: 28, fontWeight: 700 }}>Somnia Testnet Flow</h2>
      <p style={{ opacity: 0.8 }}>
        ChainId: <b>{somniaChain.id}</b> · RPC: <b>{(somniaChain.rpcUrls.default.http[0] || "").toString()}</b>
      </p>

      {!isConfigured && (
        <div style={{ padding: 12, border: "1px solid rgba(255,255,255,0.2)", borderRadius: 12, marginTop: 12 }}>
          <p style={{ margin: 0 }}>
            Set env vars: <code>NEXT_PUBLIC_TEST_INPUT_KEYS_ADDRESS</code>, <code>NEXT_PUBLIC_MIXER_ADDRESS</code>,
            <code>NEXT_PUBLIC_LOOTBOX_KEY_ADDRESS</code>, <code>NEXT_PUBLIC_LOOTBOX_ADDRESS</code>, <code>NEXT_PUBLIC_RECIPE_ID</code>.
          </p>
        </div>
      )}

      <div style={{ marginTop: 16, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button onClick={() => appKit?.open()} style={{ padding: "10px 14px" }}>
          {isConnected ? "Wallet Connected" : "Connect Wallet"}
        </button>
        <div style={{ padding: "10px 14px", opacity: 0.9 }}>
          Address: <code>{address || "—"}</code>
        </div>
      </div>

      <div style={{ marginTop: 18, padding: 14, border: "1px solid rgba(255,255,255,0.2)", borderRadius: 12 }}>
        <h3 style={{ marginTop: 0 }}>1) Get test input keys</h3>
        <p style={{ marginTop: 0, opacity: 0.8 }}>Input total (ids 1..8): <b>{inputTotal.toString()}</b></p>
        <button disabled={!isConnected || !isConfigured} onClick={mintTestKeys} style={{ padding: "10px 14px" }}>
          Mint 100 test keys (id=1)
        </button>
      </div>

      <div style={{ marginTop: 14, padding: 14, border: "1px solid rgba(255,255,255,0.2)", borderRadius: 12 }}>
        <h3 style={{ marginTop: 0 }}>2) Approve + Mix</h3>
        <p style={{ marginTop: 0, opacity: 0.8 }}>
          Input approved to Mixer: <b>{String(inputApproved)}</b>
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button disabled={!isConnected || !isConfigured} onClick={approveInputToMixer} style={{ padding: "10px 14px" }}>
            Approve input → Mixer
          </button>
          <button disabled={!isConnected || !isConfigured} onClick={mix100to1} style={{ padding: "10px 14px" }}>
            Mix 100 → 1 LootboxKey
          </button>
        </div>
      </div>

      <div style={{ marginTop: 14, padding: 14, border: "1px solid rgba(255,255,255,0.2)", borderRadius: 12 }}>
        <h3 style={{ marginTop: 0 }}>3) Open Lootbox</h3>
        <p style={{ marginTop: 0, opacity: 0.8 }}>
          LootboxKey approved to Lootbox: <b>{String(lootboxKeyApproved)}</b>
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button disabled={!isConnected || !isConfigured} onClick={approveLootboxKey} style={{ padding: "10px 14px" }}>
            Approve LootboxKey → Lootbox
          </button>
          <button disabled={!isConnected || !isConfigured} onClick={openLootbox} style={{ padding: "10px 14px" }}>
            Open Lootbox (burn 1 key)
          </button>
        </div>
        {lastReward && (
          <p style={{ marginTop: 12 }}>
            Last reward: <b>{lastReward}</b>
          </p>
        )}
      </div>

      {status && <p style={{ marginTop: 16, opacity: 0.9 }}><b>Status:</b> {status}</p>}
    </div>
  );
}


