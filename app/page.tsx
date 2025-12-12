"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useReadContracts, useWriteContract } from "wagmi";
import { parseAbi } from "viem";
import { useReown } from "./providers/AppKitProvider";
// @ts-expect-error Aurora is a JS component with no types
import Aurora from "./lootbox/Aurora";
// @ts-expect-error TiltedCard is a JS component with no types
import TiltedCard from "./lootbox/TiltedCard";

const LOOTBOX = (process.env.NEXT_PUBLIC_LOOTBOX_ADDRESS || "0x0000000000000000000000000000000000000000") as `0x${string}`;
const KEYS = (process.env.NEXT_PUBLIC_KEYS_ADDRESS || "0x2d535a2588E7c3f5F213F3b3324F44E146Ca5306") as `0x${string}`;
const KEY_IDS = (process.env.NEXT_PUBLIC_KEY_IDS || "1,2,3,4,5,6,7,8")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean)
  .map((id) => BigInt(id));

const lootboxAbi = parseAbi([
  "function openWithKey(uint256 keyId) external",
  "event OpenRequested(address indexed user, uint256 requestId)",
  "event ItemAwarded(address indexed user, uint8 itemType, address token, uint256 id, uint256 amount)"
]);

const keysAbi = parseAbi(["function balanceOf(address account, uint256 id) view returns (uint256)"]);
const REWARD_TITLE = "Quills NFT";

export default function LootboxPage() {
  const { appKit } = useReown() || {};
  const { address, isConnected } = useAccount();
  const [opening, setOpening] = useState(false);
  const [lastWin, setLastWin] = useState<string | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [rewardVisible, setRewardVisible] = useState(false);
  const [rewardDone, setRewardDone] = useState(false);
  const [burnAmount, setBurnAmount] = useState<number | null>(null);
  const [showBurnModal, setShowBurnModal] = useState(false);
  const [burnInput, setBurnInput] = useState("1");
  const [accountLabel, setAccountLabel] = useState("Connect Wallet");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rewardRef = useRef<HTMLVideoElement | null>(null);

  const { data: keysBalances } = useReadContracts({
    allowFailure: true,
    contracts: address
      ? KEY_IDS.map((id) => ({
          address: KEYS,
          abi: keysAbi,
          functionName: "balanceOf",
          args: [address, id]
        }))
      : [],
    query: { enabled: !!address }
  });

  const { writeContractAsync } = useWriteContract();

  const canOpen = useMemo(() => {
    // Demo: allow opening when wallet is connected
    return isConnected && !opening;
  }, [isConnected, opening]);

  const keysDisplay = useMemo(() => {
    if (!keysBalances) return "0";
    const sum = keysBalances.reduce((acc, entry) => {
      if (!entry || entry.status !== "success" || entry.result === undefined) return acc;
      return acc + BigInt(entry.result);
    }, 0n);
    return sum.toString();
  }, [keysBalances]);

  useEffect(() => {
    if (isConnected && address) {
      setAccountLabel(`${address.slice(0, 6)}…${address.slice(-4)}`);
    } else {
      setAccountLabel("Connect Wallet");
      setOpening(false);
      setRewardVisible(false);
      setRewardDone(false);
      setBurnAmount(null);
      setLastWin(null);
      setShowBurnModal(false);
    }
  }, [isConnected, address]);

  function beginOpenFlow() {
    if (!isConnected) {
      appKit?.open();
      return;
    }
    if (!address) return;
    setBurnInput("1");
    setShowBurnModal(true);
  }

  function confirmBurn() {
    const amount = parseInt(burnInput, 10);
    if (Number.isNaN(amount) || amount <= 0) {
      if (typeof window !== "undefined") window.alert("Enter a positive number of keys");
      return;
    }

    setBurnAmount(amount);
    setShowBurnModal(false);
    setOpening(true);
    setLastWin(null);
    setRewardVisible(false);
    setRewardDone(false);
    setVideoReady(false);

    if (rewardRef.current) {
      rewardRef.current.pause();
      rewardRef.current.currentTime = 0;
    }

    // Force reload + play once ready
    if (videoRef.current) {
      try {
        videoRef.current.pause();
        videoRef.current.currentTime = 0;
        videoRef.current.load();
        const playPromise = videoRef.current.play();
        if (playPromise && typeof playPromise.then === "function") {
          playPromise.catch(() => {});
        }
      } catch (e) {
        // swallow in demo
      }
    }
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

  async function onOpen() {
    beginOpenFlow();
  }

  function shareOnX() {
    const text = `Удача была на моей стороне: получил ${REWARD_TITLE} в Somnia Lootbox! #Somnia #Lootbox #Web3`;
    const url = typeof window !== "undefined" ? window.location.href : "https://quests.somnia.network";
    const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
    if (typeof window !== "undefined") {
      window.open(tweetUrl, "_blank", "noopener,noreferrer");
      setRewardVisible(false);
      setRewardDone(false);
    }
  }

  const rewardMode = rewardVisible || rewardDone;

  return (
    <div className={`page ${rewardMode ? "reward-mode" : ""}`}>
      <div className="bg-orb" />
      <div className="grid-lines" />
      <div className="stars" />
      <div className="aurora-hero">
        <Aurora colorStops={["#3ECCEE", "#4845F6", "#E70D6B"]} amplitude={1.2} blend={0.65} />
      </div>

      <div className={`reward-backdrop ${rewardMode ? "is-visible" : ""}`} />

      <header className="container nav">
        <div className="brand">
          <img src="/assets/somnia-logo.svg" alt="Somnia" width={28} height={28} />
          <div className="brand-text">
            <span className="eyebrow">Somnia</span>
            <strong>Odyssey Lootbox</strong>
          </div>
        </div>
        <div className="nav-actions">
          <button className="btn ghost" onClick={() => appKit?.open()}>
            <span className={`key-chip ${isConnected ? "is-visible" : "is-hidden"}`}>
              {isConnected ? `${keysDisplay} keys` : ""}
            </span>
            <span className="account-label">{accountLabel}</span>
          </button>
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
                if (!opening && !rewardVisible && !rewardDone) onOpen();
              }}
              onKeyDown={(e) => {
                if (!opening && !rewardVisible && !rewardDone && (e.key === "Enter" || e.key === " ")) {
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
                  setRewardVisible(true);
                  setRewardDone(false);
                  if (videoRef.current) {
                    videoRef.current.pause();
                  }
                  if (rewardRef.current) {
                    rewardRef.current.currentTime = 0;
                    rewardRef.current.play().catch(() => {});
                  }
                }}
                onError={() => setVideoReady(false)}
              />
              <div className="chest-shine" />
            </div>
          </div>

          <div className="cta-stack">
            <button className="btn primary xl" disabled={!canOpen} onClick={onOpen}>
              {opening ? "Rolling…" : "Open the Somnia Lootbox"}
            </button>
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
                src="/assets/card01.webm"
                playsInline
                muted
                preload="auto"
                loop={false}
                onLoadedData={() => {
                  if (rewardRef.current) {
                    rewardRef.current.currentTime = 0;
                    if (rewardVisible) {
                      rewardRef.current.play().catch(() => {});
                    } else {
                      rewardRef.current.pause();
                    }
                  }
                }}
                onEnded={() => {
                  setOpening(false);
                  setRewardDone(true);
                  const count = burnAmount ?? 1;
                  setLastWin(`Reward received: Prototype Reward · keys burned: ${count}`);
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
              <p className="eyebrow">Set amount</p>
              <h3>How many NFT keys to burn?</h3>
              <p className="modal-sub">Keys will be burned for a single reward in this demo</p>
            </div>
            <label className="input-label" htmlFor="burn-count">Amount</label>
            <div className="input-row">
              <input
                id="burn-count"
                type="number"
                min={1}
                value={burnInput}
                onChange={(e) => setBurnInput(e.target.value)}
                className="neo-input"
              />
              <span className="suffix">NFT</span>
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setShowBurnModal(false)} disabled={opening}>Cancel</button>
              <button className="btn primary" onClick={confirmBurn} disabled={opening}>Open</button>
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
    </div>
  );
}


