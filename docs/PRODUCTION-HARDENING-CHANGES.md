# Production hardening changelog

## Solidity

### `SomniaLootboxVRF.sol`

- **VRF stuck recovery**: Tracks `requestCreatedAt`, `requestKeyId`, `userPendingRequestId`; configurable `vrfRecoveryTimeoutSeconds` (default 1 day, min 1h, max 30d). `recoverMyStuckVrfRequest()` (user) and `recoverStuckVrfRequest(requestId)` (`onlyOwner`) remint the same key via an extended key interface after timeout; `VrfRequestRecovered` event; double recovery and late fulfill after recovery are safe (fulfill reverts on unknown request).
- **Views**: `effectiveRemainingTotal()`, `getPendingRequest(user)` (pending, requestId, keyId, createdAt, recoveryEligible).
- **setPrize**: Validates `ERC721_VAULT` (`token != 0`, `amount == 1`), `POINTS` (`amount > 0`), `NONE` (only with `remaining == 0`). `ERC20` disabled unless `erc20NativePrizesEnabled` (default `false`); `setErc20NativePrizesEnabled` and `setVrfRecoveryTimeoutSeconds` only while `!configLocked`.
- **Key interface**: `ILootboxKeyForLootbox` — `burn` + `mint`; deploy grants `MINTER_ROLE` on `LootboxKey` to the lootbox.

### `RewardVaultERC721.sol`

- **`deposit`**: `onlyOwner` (treasury/ops).
- **Lootbox binding**: `setLootbox` blocked after `lockLootbox()`; `LootboxLocked` / `LootboxUnset` errors; `LootboxLockedEvent`.

### `Mixer.sol`

- No logic change; **deploy scripts** now use **BURN** (`mode: 1`) and **32** keys for Odyssey alignment with the app.

## Off-chain (Next.js)

### `lib/rewards-indexing.ts` + `app/api/rewards/route.ts`

- **Points**: Source of truth is **`PointsAwarded`**; Redis total is `newTotal` from each event (chain-anchored).
- **Dedup**: `txHash:logIndex` via sets `lootboxes:points:seen:*` and `lootboxes:rewards:itemseen:*` (replaces single `txHash` global dedupe for rewards).
- **ItemAwarded**: Still drives reward list entries; points balance is not incremented from `ItemAwarded` alone.
- **Replay**: Re-posting the same tx does not double points or duplicate list rows.

## Scripts

- **`deploy-mainnet-vrf-stack.js`**: Odyssey recipe **BURN**, `consumeTo` zeroed; **grants `LootboxKey.MINTER_ROLE` to lootbox**; ops checklist in console.
- **`finalize-mainnet-lootbox.js`**: Optional **`vault.lockLootbox()`** (default on; set `LOCK_VAULT_LOOTBOX=0` to skip).
- **`deploy-mixer-somnia.js`**: **32** inputs, **BURN** mode (aligned with main app).

## Tests

- **`hardhat/contracts/mocks/MockVRFV2PlusWrapper.sol`**: Native VRF wrapper mock.
- **`hardhat/test/SomniaLootboxVRF.test.js`**: Points path, ERC721 vault+claim, stuck VRF + recovery, `setPrize` validation, views; vault hardening.
- **Hardhat ESM**: Tests import `hre` default export for Node ESM compatibility.
- **`lib/rewards-indexing.test.ts`**: Vitest unit tests for parsing and points/item separation.
- **Chai / ethers v6**: Bigint expectations fixed across existing tests; `Lootbox` sold-out test uses a second user to assert `SoldOut` vs `PendingRequest`.

## Manual pre-mainnet checklist

1. Grant **`LootboxKey.MINTER_ROLE`** to **`SomniaLootboxVRF`** (included in deploy script; verify on upgrades).
2. **`mixer.freezeRecipe(recipeId)`** after recipe review.
3. **`vault.lockLootbox()`** after `setLootbox` (or use finalize script).
4. **`lootbox.lockConfig()`** only after prize table + VRF params are final.
5. Fund lootbox **native** balance for VRF; fund **Quills** into vault via **`deposit`** (owner-only).
6. Confirm **no** `setErc20NativePrizesEnabled(true)` for current production (unless ERC20 path is intended).
7. Redis: `UPSTASH_*`, `RPC_URL` / `NEXT_PUBLIC_RPC_URL` consistent with chain; verify worker/POST indexing after first real open.

## Non-blocking / optional

- **Reorgs**: API indexing does not rewind chain events; consider a dedicated indexer with reorg depth if required.
- **`add-test-recipe-somnia.js`**: Still useful for non-prod recipes; comments may mention ESCROW for ad-hoc tests — production path is BURN via main deploy script.
