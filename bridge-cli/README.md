# bridge-cli

Non-interactive CLI for the **Midnight Bridge contract**. All inputs are via CLI flags and environment variables. It is used by the rollup node (Rust) as a subprocess to build and submit Bridge transactions, and by users for actions like claiming withdrawals.

---

## Role in the project

We're building a **rollup (layer 2)** over the Midnight blockchain. Key pieces:

- **Bridge smart contract** (L1) – deployed on Midnight; developed in this repo (`bridge-contract/`).
- **Rollup node** – processes L2 transactions and periodically settles on Midnight; developed in a separate repo (Rust).

The rollup node must interact with Midnight in two ways:

1. **Reading Bridge state** (e.g. to see user deposits) – already done in pure Rust in the rollup repo.
2. **Sending transactions** – calling Bridge circuits to commit/finalize batches, change authorities, withdraw fees, etc. Building and proving these calls depends on Bridge compilation artifacts (JS/TS), so they cannot be fully implemented in Rust.

**bridge-cli** is the TypeScript layer that:

- Builds and proves Bridge contract calls (commit batch, finalize batch, set verifier set, claim withdrawal, etc.).
- Can be invoked from the Rust rollup node as a **subprocess**: the node passes arguments and env, bridge-cli runs without stdin and exits with 0 on success.

So: **Rust owns orchestration and ledger logic; bridge-cli owns transaction construction and submission (or output of signed tx hex for Rust to submit).**

---

## Onboarding (developers and AI agents)

### Repo layout

- **`src/cli.ts`** – Entrypoint. Commander-based CLI; defines commands and global options.
- **`src/commands/`** – One module per command: `state`, `commit-batch`, `finalize-batch`, `finalize-batch-from-ledger`, `set-verifier-set`, `claim-l1-withdrawal-unshielded`.
- **`src/batch-helpers.ts`** – Shared batch/signature logic: ledger helpers, `buildBatchPublicData`, `buildSignatureVector`, JSON parse/serialize for `BatchPublicDataV1Full` and `Signature[]`, hashing.
- **`src/api.ts`** – Wallet build, provider config, `joinContract`, contract call helpers; used by all commands that submit transactions.
- **`src/cli-config.ts`** – Resolves config and contract address from env and optional CLI overrides.
- **Contract types** – Generated Bridge types (e.g. `L1_BatchPublicDataV1Full`, `Signature`) live in `bridge-contract/dist/managed/Bridge/contract/`; the CLI imports from `bridge-contract/browser`.

### Running

```bash
npm install
npm run cli -- <command> [options]
# or
npx tsx src/cli.ts <command> [options]
```

Use `.env` or pass flags; see Environment variables and Examples below.

### Rust ↔ TS boundary

- **commit-batch**: Rust computes `parent_hash` and `batch_hash` (e.g. from its ledger), then runs bridge-cli with `--parent-hash` and `--batch-hash`. No ledger read inside the CLI for this command.
- **finalize-batch**: Contract signature is `finalizeBatch(batchPublicData_, signatures_, signerBitmap_, finalizeTimestamp_)`. The CLI accepts these **four arguments** (first two as JSON strings). Rust can compute them (ledger + batch data + signatures) and pass them in; or use the TS blueprint in `finalize-batch-from-ledger` (single wallet session: ensure pending batch, build batch data, sign, submit).
- **Subprocess**: From the rollup repo, see `bridge-cli/decoder-rs` (in this repo), which invokes the TS CLI for commit/finalize with the right argv and env. Use the same pattern from the actual rollup node.

### Testing and scripts

- **`npm run cli -- state`** – No wallet; good smoke test for config and indexer.
- **`src/test-decode.ts`** – Dev script: runs `state`, then (if not skipped) `finalize-batch-from-ledger` on undeployed network. Uses same command logic as the CLI.
- **`bridge-cli/decoder-rs`** – Rust CLI that calls the TS bridge-cli for commit/finalize; useful to test the Rust→TS flow and JSON serialization of batch/signatures.

### Design notes

- **Non-interactive**: No readline; everything via argv and env so it’s scriptable and subprocess-friendly.
- **Explicit args**: Commands that map to contract calls (e.g. `finalize-batch`) take the same arguments as the contract; construction from ledger is in separate commands or helpers (e.g. `finalize-batch-from-ledger`, `getFinalizeBatchArgsFromLedger`).
- **Interactive TUI** – For deploy/join and exploratory use, `npm run tui-undeployed` / `tui-preview`; entrypoint is `cli-interactive.ts`.

---

## Commands

Run with `npm run cli -- <command>` or `npx tsx src/cli.ts <command>`:

| Command | Description |
|---------|-------------|
| `deploy` | Deploy the Bridge contract. Network via `-n`/`--network` or `MIDNIGHT_NETWORK`. Wallet: `--deployer-seed <hex>` or `FUNDING_SEED` / `MY_PREVIEW_MNEMONIC`. |
| `state` | Read and print Bridge state (ledger summary, L1→L2 deposits). No wallet required. |
| `commit-batch` | Commit a batch (rollup node). Requires `--parent-hash` and `--batch-hash`. Requires wallet. |
| `finalize-batch` | Finalize a batch. Requires the four `finalizeBatch` arguments as CLI args (see below). |
| `finalize-batch-from-ledger` | Build those four args from ledger (ensurePendingBatch, buildBatchPublicData, sign) and submit. Test/blueprint command. |
| `set-verifier-set` | Set the Bridge verifier set (admin). Requires wallet. |
| `claim-l1-withdrawal-unshielded` | Claim L1 withdrawal (user). Requires `--recipient` and `--amount`. |

## Environment variables

- `BRIDGE_CONTRACT_ADDRESS` – Bridge contract address (64 hex chars). Required for all commands.
- `INDEXER_HTTP`, `INDEXER_WS` – Indexer GraphQL HTTP and WebSocket URLs.
- `MIDNIGHT_NODE_WS` or `NODE_WS` – Midnight node WebSocket URL.
- `PROOF_SERVER` – Proof server URL.
- `MIDNIGHT_NETWORK` – `preview` or `undeployed` (default: preview).
- `FUNDING_SEED` or `MY_PREVIEW_MNEMONIC` – Wallet seed (hex) or mnemonic for signing commands.
- `SIGNATURE_MAX_NONCE` – Max nonce for finalize-batch signature generation (optional).
- `MY_UNDEPLOYED_UNSHIELDED_ADDRESS` – Optional. Bech32m unshielded address for standalone setup (`npm run setup-standalone`). If set, the script sends a test transfer to that address; if unset, the transfer is skipped.

Add `--json` for machine-readable output (e.g. `{ "txHash": "...", "status": "submitted" }`).

## Examples

```bash
# Deploy Bridge (undeployed/local or preview)
npm run cli -- deploy -n undeployed
# Or with explicit deployer seed and JSON output
npm run cli -- deploy -n undeployed --deployer-seed <64_hex> --json

# State (no wallet)
BRIDGE_CONTRACT_ADDRESS=<hex> npm run cli -- state

# Commit a batch (rollup node; parent and batch hash required)
npm run cli -- commit-batch --parent-hash <64_hex> --batch-hash <64_hex>
# With env for contract and wallet
BRIDGE_CONTRACT_ADDRESS=<hex> FUNDING_SEED=<hex> npm run cli -- commit-batch --parent-hash <64_hex> --batch-hash <64_hex>

# Finalize batch (four required args: batch public data JSON, signatures JSON, signer bitmap, timestamp)
npm run cli -- finalize-batch \
  --batch-public-data '<BatchPublicDataV1Full JSON>' \
  --signatures '<[Signature; 3] JSON>' \
  --signer-bitmap <n> \
  --finalize-timestamp <n>
# BatchPublicDataV1Full: Bytes<32> as 64 hex chars, numbers as strings. Signature: { pk: {x,y}, r: {x,y}, s }.

# Or build args from ledger and submit (test command)
npm run cli -- finalize-batch-from-ledger

# Claim withdrawal (user)
npm run cli -- claim-l1-withdrawal-unshielded --recipient <64_hex> --amount <decimal>
```

## Calling from Rust (subprocess)

Invoke the CLI with no stdin; pass all config via argv and env:

```bash
node path/to/bridge-cli/dist/cli.js commit-batch --contract <addr>
# or: npx tsx path/to/bridge-cli/src/cli.ts commit-batch --contract <addr>
```

Set `BRIDGE_CONTRACT_ADDRESS`, `INDEXER_HTTP`, `FUNDING_SEED`, etc. in the environment of the spawned process. Exit code 0 on success; non-zero and stderr on failure.

A future `--output-tx=hex` flag may be added so that TS builds and proves the transaction but prints the finalized tx hex to stdout instead of submitting; Rust could then submit that hex (e.g. for retries or a different node).

## Interactive TUI

For the interactive deploy/join and display state flow, use:

```bash
npm run tui-undeployed   # local/standalone
npm run tui-preview      # preview network
```
