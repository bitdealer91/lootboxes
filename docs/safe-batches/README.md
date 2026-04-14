# Somnia Safe — batch JSON for Quills prize vault

Use these files on **[Somnia Safe](https://safe.somnia.network)** → **Transaction Builder** → drag & drop the JSON (or “choose file”).

## Contracts (Somnia mainnet, chain ID **5031**)

| Role | Address |
|------|---------|
| Quills ERC721 | `0x90780d0641a6328719a636ab289175e2155328a3` |
| Prize vault (`RewardVaultERC721`) | `0xF24c285758D1A07a5a90011b2C3f85020c7A35e9` |

## Files

| File | Second transaction |
|------|--------------------|
| `quills-vault-deposit-tokenid-1.json` | `deposit([1])` — use only if the Safe **owns** Quills **tokenId 1** |
| `quills-vault-deposit-tokenid-123.json` | `deposit([123])` — use only if the Safe **owns** **tokenId 123** |
| `quills-vault-deposit-tokenid-209.json` | `deposit([209])` — use only if the Safe **owns** **tokenId 209** |
| `quills-vault-deposit-batch-210-262.json` | `deposit([52 ids])` — **210–262** with **250** and **265** omitted (matches your first encoder run) |
| `quills-vault-deposit-batch-263-319-mixed.json` | `deposit([47 ids])` — **263,264,266–287,154,161,160,159,319,208–191** (matches your second encoder run) |

Both batches include:

1. **Tx1:** `setApprovalForAll(vault, true)` on the Quills collection (same for every batch).
2. **Tx2:** `deposit(tokenIds)` on the vault — **calldata depends on token IDs**.

**Do not** use a file if your `tokenId` does not match — the transaction will fail or deposit the wrong id.

## Other token IDs or multiple IDs

From repo root:

```bash
cd hardhat
QUILLS_ADDRESS=0x90780d0641a6328719a636ab289175e2155328a3 \
QUILLS_VAULT_ADDRESS=0xF24c285758D1A07a5a90011b2C3f85020c7A35e9 \
TOKEN_IDS=10,11,12 \
npx hardhat run ./scripts/encode-safe-quills-deposit.js --network hardhat
```

Copy the printed **Tx1** `data` (unchanged) and **Tx2** `data` into a new JSON file using the same structure as the examples (only `transactions[1].data` changes for a different id list).

## After execution

- On Quills: `ownerOf(tokenId)` should equal the vault address for each deposited id.
- On vault: `remaining()` should increase by the number of deposited tokens.

## If JSON import fails

The UI may expect a slightly different schema. Send us the error message, or use **Contract interaction** with the minimal ABI fragments described in project comms, or paste **To + Data** from the encoder script.
