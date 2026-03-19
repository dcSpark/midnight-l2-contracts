# bridge-cli

Non-interactive CLI for the **Midnight Bridge contract**. All inputs are via CLI flags and environment variables. The **Rust rollup node** integrates only with the **executor service** (HTTP API); it does not spawn the CLI. The standalone CLI is for operators and one-off commands (deploy, state, deposit, claim withdrawal, etc.).

---

## Role in the project

We're building a **rollup (layer 2)** over the Midnight blockchain. Key pieces:

- **Bridge smart contract** (L1) – deployed on Midnight; developed in this repo (`bridge-contract/`).
- **Rollup node** – processes L2 transactions and periodically settles on Midnight; developed in a separate repo (Rust).

The rollup node must interact with Midnight in two ways:

1. **Reading Bridge state** (e.g. to see user deposits) – already done in pure Rust in the rollup repo.
2. **Sending transactions** – calling Bridge circuits to commit/finalize batches, change authorities, withdraw fees, etc. Building and proving these calls depends on Bridge compilation artifacts (JS/TS), so they cannot be fully implemented in Rust.

**bridge-cli** is the TypeScript layer that builds and proves Bridge contract calls (commit batch, finalize batch, set verifier set, claim withdrawal, etc.). The rollup node does **not** spawn the TS CLI. It calls the **executor service** over HTTP: a long-lived process that builds the wallet once, joins the contract, and exposes commit-batch, finalize-batch, set-verifier-set, and other operations as REST endpoints. The **standalone CLI** (`npm run cli -- …`) is for humans and scripts (deploy, state, deposit, one-off finalize, etc.); the **executor** is what the rollup node uses.

---

## Onboarding (developers and AI agents)

### Repo layout

- **`src/cli.ts`** – Entrypoint. Commander-based CLI; defines commands and global options.
- **`src/commands/`** – One module per command: `state`, `deposit`, `commit-batch`, `finalize-batch`, `finalize-batch-from-ledger`, `set-verifier-set`, `claim-l1-withdrawal-unshielded`.
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

### Rust ↔ executor boundary

The rollup node (or any client) calls the executor HTTP API only. Example flows:

- **commit-batch**: Rust computes `parent_hash` and `batch_hash` (e.g. from its ledger), then sends `POST /commit-batch` with body `{ "parentHash", "batchHash" }`.
- **finalize-batch**: Contract signature is `finalizeBatch(batchPublicData_, signatures_, signerBitmap_, finalizeTimestamp_)`. Rust sends `POST /finalize-batch` with the same four inputs (batchPublicData, signatures, signerBitmap, finalizeTimestamp). Alternatively, the TS blueprint in `finalize-batch-from-ledger` (single wallet session: ensure pending batch, build batch data, sign, submit) can be used via `POST /finalize-batch-from-ledger`.

### Testing and scripts

- **`npm run cli -- state`** – No wallet; good smoke test for config and indexer.
- **`src/test-decode.ts`** – Dev script: runs `state`, then (if not skipped) `finalize-batch-from-ledger` on undeployed network. Uses same command logic as the CLI.
- **`bridge-cli/decoder-rs`** – Rust CLI that calls the executor HTTP endpoints for commit/finalize; useful to test the Rust→executor flow and JSON serialization of batch/signatures.

---

## Commands

Run with `npm run cli -- <command>` or `npx tsx src/cli.ts <command>`:

| Command | Description |
|---------|-------------|
| `deploy` | Deploy the Bridge contract. Network via `-n`/`--network` or `MIDNIGHT_NETWORK`. Wallet: `--deployer-seed <hex>` or `FUNDING_SEED` / `MY_PREVIEW_MNEMONIC`. |
| `state` | Read and print Bridge state (ledger summary, L1→L2 deposits). No wallet required. |
| `deposit` | Deposit unshielded NIGHT to L2 (call `depositNIGHTUnshielded`). Requires `--amount`. Optional `--l2-recipient` (64 hex or sov-format e.g. sov1...), `--gas-limit`, `--timestamp`. Requires wallet. |
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
- `SIGNATURE_NONCE` – Base nonce for finalize-batch signature generation (optional; default 1).
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

# Deposit unshielded NIGHT to L2 (default: recipient = wallet's coin public key)
npm run cli -- deposit --amount 1000
# With explicit L2 recipient (64 hex) and optional gas limit / timestamp
npm run cli -- deposit --amount 1000 --l2-recipient <64_hex> --gas-limit 100000 --timestamp 0
# or with sov-format L2 address:
npm run cli -- deposit --amount 1000 --l2-recipient sov1lzkjgdaz08su3yevqu6ceywufl35se9f33kztu5cu2spja5hyyf

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

## Executor service

The CLI can run as a **long-lived executor service** that builds and syncs the wallet once at startup, joins the contract, and exposes all transaction commands as HTTP endpoints. This avoids per-command wallet sync when the Rust CLI (or another client) calls it repeatedly.

### Configuration

Use the same environment variables as the one-shot CLI. The service resolves config at startup and keeps one wallet + contract join for the process lifetime.

- **Required**: `BRIDGE_CONTRACT_ADDRESS`, `INDEXER_HTTP`, `MIDNIGHT_NODE_WS` (or `NODE_WS`), `PROOF_SERVER`, `FUNDING_SEED` (or `MY_PREVIEW_MNEMONIC`).
- **Optional**: `INDEXER_WS`, `MIDNIGHT_NETWORK` (`preview` / `undeployed`), `BRIDGE_ARTIFACTS`, `SIGNATURE_NONCE`.

Server binding:

- **`EXECUTOR_PORT`** or **`PORT`** – Port to listen on (default: `3000`).
- **`EXECUTOR_HOST`** – Host to bind (default: `0.0.0.0`).

### Starting the service

From the `bridge-cli` directory:

```bash
npm install
# Set env (e.g. in .env or export)
export BRIDGE_CONTRACT_ADDRESS="<64_hex>"
export INDEXER_HTTP="http://127.0.0.1:8088/api/v3/graphql"
export MIDNIGHT_NODE_WS="ws://127.0.0.1:9944"
export PROOF_SERVER="http://127.0.0.1:6300"
export FUNDING_SEED="<hex_or_mnemonic>"

npm run executor
```

Or with explicit port and host:

```bash
EXECUTOR_PORT=3000 EXECUTOR_HOST=127.0.0.1 npm run executor
```

On startup the service:

1. Resolves config from env.
2. Builds the wallet (from `FUNDING_SEED` or mnemonic), waits for sync, configures providers, and joins the contract at `BRIDGE_CONTRACT_ADDRESS`.
3. Starts the HTTP server. Once ready, `GET /health` and `GET /ready` return 200.

On **SIGINT** or **SIGTERM** the service closes the wallet and exits.

### Endpoints

All request/response bodies are JSON. On error the response has status 4xx/5xx and a body `{ "error": "message" }`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health`, `/ready` | Health check; 200 when context is ready. |
| GET | `/state` | Bridge state (same as CLI `state`). Response: state object. |
| POST | `/commit-batch` | Body: `{ "parentHash", "batchHash" }`. |
| POST | `/finalize-batch` | Body: `{ "batchPublicData", "signatures", "signerBitmap", "finalizeTimestamp" }`. |
| POST | `/finalize-batch-from-ledger` | No body. Builds args from ledger and submits. |
| POST | `/set-verifier-set` | No body. |
| POST | `/claim-l1-withdrawal-unshielded` | Body: `{ "recipient", "amount" }`. |
| POST | `/deposit` | Body: `{ "amount" }`; optional `l2Recipient` (32-byte hex or sov-format e.g. sov1...), `gasLimit`, `timestamp`. |
| POST | `/relay-withdraw-night-with-proof` | Body: `l2Sender`, `recipient`, `amount`, `batchIndex`, `nonce`, `indexBits`, `siblings`. |
| POST | `/test-withdraw` | Body: optional same options as CLI (e.g. `depositAmount`, `skipSetVerifierSet`, `waitAttempts`, `waitDelayMs`). |
| POST | `/deploy` | Body: optional `{ "deployerSeed" }` and deploy/init overrides (`owner`, `layer2ChainId`, `rollupId`, `genesisStateRoot`, `genesisBatchHash`, `verifierSet`, `signatureThreshold`, `initialSequencer`, `initialFinalizer`). Internally this runs deploy, then `initialize` in a second tx. |
| POST | `/build-signatures` | Body: `{ "batchPublicData" }` (object or JSON string), optional `signatureNonce` (base nonce, number or string). Returns `{ "signatures": "<JSON string>" }` for use in finalize-batch. |

Success responses return the same shape as the CLI JSON output (e.g. `{ "txHash", "status" }`).

---

## Deploying the Bridge contract

Deploy with the CLI or via the executor's `POST /deploy` endpoint. Wallet is taken from `--deployer-seed` or env (`FUNDING_SEED` / `MY_PREVIEW_MNEMONIC`). The deploy flow is two-step: deploy with owner-only constructor, then call `initialize` in a second transaction.

**CLI:** From the `bridge-cli` directory (or project root with `npm run cli`):

```bash
npm run cli -- deploy -n undeployed
# or preview: npm run cli -- deploy -n preview
# Optional: --deployer-seed <64_hex> --json
```

All deploy/init arguments are **optional**. If omitted, defaults are used. `owner` is used in the constructor; the remaining values are passed to `initialize` after deploy. You can override any subset via CLI flags or, for `POST /deploy`, via the request body.

| Argument | CLI flag | Default |
|----------|----------|---------|
| owner | `--owner <64 hex>` | Deployer coin public key |
| layer2ChainId | `--layer2-chain-id <n>` | 0 |
| rollupId | `--rollup-id <64 hex>` | 32 zero bytes |
| genesisStateRoot | `--genesis-state-root <64 hex>` | 32 zero bytes |
| genesisBatchHash | `--genesis-batch-hash <64 hex>` | 32 zero bytes |
| verifierSet | `--verifier-set <json>` | Default 3 points from default keys |
| signatureThreshold | `--signature-threshold <n>` | 1 |
| initialSequencer | `--initial-sequencer <64 hex>` | Deployer coin public key |
| initialFinalizer | `--initial-finalizer <64 hex>` | 32 zero bytes |

**Example** – deploy with only genesis state root overridden:

```bash
npm run cli -- deploy -n undeployed --genesis-state-root 6c0ab7442e390ff41c99a7b864bae8a72869490f73a0ada97006877d01a9fa0b
```

**Executor:** `POST /deploy` accepts the same optional fields in the JSON body: `owner`, `layer2ChainId`, `rollupId`, `genesisStateRoot`, `genesisBatchHash`, `verifierSet`, `signatureThreshold`, `initialSequencer`, `initialFinalizer`. Bytes&lt;32&gt; as 64-char hex; verifierSet as array of 3 points `[{ "x", "y" }, ...]`. The endpoint executes deploy + initialize before returning success.

---

## Calling from Rust

The rollup node (or any client) should use the **executor service** only. Start it once with `npm run executor` in `bridge-cli`, set `EXECUTOR_URL` (or equivalent) in the rollup config, and call the documented POST endpoints (`/commit-batch`, `/finalize-batch`, `/set-verifier-set`, etc.). No subprocess invocation. The one-shot CLI (`npm run cli -- <command>`) remains available for manual or script use.

## Interactive TUI

For the interactive deploy/join and display state flow, use:

```bash
npm run tui-undeployed   # local/standalone
npm run tui-preview      # preview network
```
