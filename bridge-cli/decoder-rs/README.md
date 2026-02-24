# decoder-rs

`decoder-rs` is a Rust CLI for interacting with Midnight Bridge contracts on local or remote Midnight networks.

- **decode**: Reads and prints Bridge contract state from the indexer (pure Rust).
- **commit-batch** / **finalize-batch**: Commit and finalize batches by **delegating to the TypeScript bridge-cli**. The pure-Rust path for commit/finalize does not work; these commands either call the **executor service** over HTTP (if `EXECUTOR_URL` is set) or spawn the bridge-cli (TS) subprocess.
  - `commit-batch` builds a mock `BatchPublicDataV1Full`, derives `batchHash` from it, and writes the full batch to `.mock-batches/latest.json`.
  - `finalize-batch` reads `.mock-batches/latest.json` and uses that payload to construct finalize inputs.
- **deposit**, **set-verifier-set**, **relay-withdraw-night-with-proof**, **claim-l1-withdrawal**, **test-withdraw**: Same delegation—HTTP to the executor when `EXECUTOR_URL` is set, otherwise TS subprocess.

## Prerequisites

- Rust toolchain (stable, with `cargo`)
- For **decode** only: running indexer GraphQL endpoint (default `http://127.0.0.1:8088/api/v3/graphql`)
- For bridge actions (commit-batch, finalize-batch, deposit, etc.):
  - **With executor**: A running bridge-cli executor service (see [Using the executor service](#using-the-executor-service) below). No Node on the machine running decoder-rs is required.
  - **Without executor**: Node.js with `npx` and `tsx` (the TS bridge-cli is run as a subprocess). Same Midnight services as the bridge-cli (node WS, indexer, proof server, wallet seed). Run from `bridge-cli/decoder-rs` so the parent directory is the bridge-cli package root, or set `BRIDGE_CLI_DIR` to that path.

## Commands

Run from `bridge-cli/decoder-rs`:

```bash
cargo run -- decode
```

```bash
cargo run -- commit-batch
```

```bash
cargo run -- finalize-batch
```

```bash
cargo run -- deposit --amount <decimal> [--l2-recipient <64_hex>] [--gas-limit <decimal>] [--timestamp <decimal>]
```

```bash
cargo run -- set-verifier-set
```

```bash
cargo run -- relay-withdraw-night-with-proof \
  --l2-sender <64_hex> \
  --recipient <64_hex> \
  --amount <decimal> \
  --batch-index <decimal> \
  --nonce <decimal> \
  --index-bits '<json_bool_array_len_16>' \
  --siblings '<json_hex_array_len_16>'
```

```bash
cargo run -- claim-l1-withdrawal --recipient <64_hex> --amount <decimal>
```

```bash
cargo run -- test-withdraw
```

## Mock batch flow

`commit-batch` and `finalize-batch` are now coupled through a persisted mock batch file:

1. Run `commit-batch`.
2. It fetches ledger context, builds a mock `BatchPublicDataV1Full`, derives `batchHash`, and submits `commitBatch(parentHash, batchHash)`.
3. It writes the full mock batch JSON to `decoder-rs/.mock-batches/latest.json`.
4. Run `finalize-batch`.
5. It reads `decoder-rs/.mock-batches/latest.json`, validates it against on-chain pending batch index/hash, signs, and submits `finalizeBatch(...)`.

If `latest.json` is missing or stale for the current chain state, `finalize-batch` fails with a validation error.

## Local Network Examples

Decode (pure Rust):

```bash
INDEXER_HTTP="http://127.0.0.1:8088/api/v3/graphql" \
BRIDGE_CONTRACT_ADDRESS="<64_hex_bridge_address>" \
cargo run -- decode
```

Commit batch (delegates to bridge-cli TS):

```bash
INDEXER_HTTP="http://127.0.0.1:8088/api/v3/graphql" \
MIDNIGHT_NODE_WS="ws://127.0.0.1:9944" \
BRIDGE_CONTRACT_ADDRESS="<64_hex_bridge_address>" \
FUNDING_SEED="<wallet_seed_or_mnemonic>" \
cargo run -- commit-batch
```

Finalize batch (delegates to bridge-cli TS):

```bash
INDEXER_HTTP="http://127.0.0.1:8088/api/v3/graphql" \
MIDNIGHT_NODE_WS="ws://127.0.0.1:9944" \
PROOF_SERVER="http://127.0.0.1:6300" \
BRIDGE_CONTRACT_ADDRESS="<64_hex_bridge_address>" \
FUNDING_SEED="<wallet_seed_or_mnemonic>" \
cargo run -- finalize-batch
```

Deposit (delegates to bridge-cli TS):

```bash
INDEXER_HTTP="http://127.0.0.1:8088/api/v3/graphql" \
MIDNIGHT_NODE_WS="ws://127.0.0.1:9944" \
PROOF_SERVER="http://127.0.0.1:6300" \
BRIDGE_CONTRACT_ADDRESS="<64_hex_bridge_address>" \
FUNDING_SEED="<wallet_seed_or_mnemonic>" \
cargo run -- deposit --amount 100
```

Set verifier set (delegates to bridge-cli TS):

```bash
INDEXER_HTTP="http://127.0.0.1:8088/api/v3/graphql" \
MIDNIGHT_NODE_WS="ws://127.0.0.1:9944" \
PROOF_SERVER="http://127.0.0.1:6300" \
BRIDGE_CONTRACT_ADDRESS="<64_hex_bridge_address>" \
FUNDING_SEED="<wallet_seed_or_mnemonic>" \
cargo run -- set-verifier-set
```

Claim L1 withdrawal (delegates to bridge-cli TS unshielded claim):

```bash
INDEXER_HTTP="http://127.0.0.1:8088/api/v3/graphql" \
MIDNIGHT_NODE_WS="ws://127.0.0.1:9944" \
PROOF_SERVER="http://127.0.0.1:6300" \
BRIDGE_CONTRACT_ADDRESS="<64_hex_bridge_address>" \
FUNDING_SEED="<wallet_seed_or_mnemonic>" \
cargo run -- claim-l1-withdrawal --recipient "<64_hex_recipient>" --amount 10
```

Test withdrawal flow (Rust orchestration + TS low-level calls):

```bash
INDEXER_HTTP="http://127.0.0.1:8088/api/v3/graphql" \
MIDNIGHT_NODE_WS="ws://127.0.0.1:9944" \
PROOF_SERVER="http://127.0.0.1:6300" \
BRIDGE_CONTRACT_ADDRESS="<64_hex_bridge_address>" \
FUNDING_SEED="<wallet_seed_or_mnemonic>" \
cargo run -- test-withdraw --deposit-amount 20 --wait-attempts 30 --wait-delay-ms 2000
```

## Using the executor service

When the **bridge-cli executor service** is running, you can point decoder-rs at it so that all bridge actions (commit-batch, finalize-batch, deposit, set-verifier-set, relay-withdraw-night-with-proof, claim-l1-withdrawal, test-withdraw) are sent over HTTP instead of spawning the TS CLI. This avoids per-command wallet sync and is faster for repeated calls.

1. **Start the executor** (in the `bridge-cli` directory, one level up from `decoder-rs`):

   ```bash
   cd ..   # from decoder-rs to bridge-cli
   npm install
   export BRIDGE_CONTRACT_ADDRESS="<64_hex>"
   export INDEXER_HTTP="http://127.0.0.1:8088/api/v3/graphql"
   export MIDNIGHT_NODE_WS="ws://127.0.0.1:9944"
   export PROOF_SERVER="http://127.0.0.1:6300"
   export FUNDING_SEED="<hex_or_mnemonic>"
   npm run executor
   ```

   The service listens on `http://0.0.0.0:3000` by default. Wait until it logs that the executor context is ready (or call `GET http://127.0.0.1:3000/health` until 200).

2. **Run decoder-rs with the executor URL** (from `bridge-cli/decoder-rs`):

   ```bash
   export EXECUTOR_URL="http://127.0.0.1:3000"
   cargo run -- commit-batch
   cargo run -- finalize-batch
   cargo run -- deposit --amount 100
   ```

   Or pass the URL on the command line:

   ```bash
   cargo run -- --executor-url http://127.0.0.1:3000 commit-batch
   cargo run -- --executor-url http://127.0.0.1:3000 deposit --amount 100
   ```

   For **decode**, the executor is not used (decode is pure Rust and only needs the indexer). You can still set `EXECUTOR_URL`; it is ignored for decode.

   If `EXECUTOR_URL` (or `--executor-url`) is **not** set, decoder-rs falls back to the previous behaviour: it spawns the TypeScript bridge-cli as a subprocess for each command, using `BRIDGE_CLI_DIR`, Node, and the same env vars.

## Environment Variables

- `BRIDGE_CONTRACT_ADDRESS`: Bridge contract address, 64 hex chars
- `INDEXER_HTTP`: indexer GraphQL endpoint
- `MIDNIGHT_NODE_WS`: Midnight node WS endpoint
- `PROOF_SERVER`: proof server endpoint
- `FUNDING_SEED`: wallet seed (or mnemonic) used for transaction funding (for subprocess mode; executor has its own wallet)
- `EXECUTOR_URL`: optional; base URL of the bridge-cli executor service (e.g. `http://127.0.0.1:3000`). When set, bridge actions use HTTP instead of the TS subprocess.
- `BRIDGE_CLI_DIR`: optional; directory containing the bridge-cli package (default: parent of decoder-rs). Only used when **not** using the executor.
- `BRIDGE_ARTIFACTS`: path containing Bridge `keys/` and `zkir/`
- `SIGNATURE_MAX_NONCE`: max nonce scan depth for signature generation (passed to TS or executor)

You can also pass these as CLI flags (`--contract`, `--indexer`, `--node-ws`, `--executor-url`, and so on).

## Troubleshooting

- If **commit-batch** or **finalize-batch** fails with "failed to run bridge-cli", ensure Node.js, `npx`, and `tsx` are installed and that you are running from `bridge-cli/decoder-rs` (or set `BRIDGE_CLI_DIR`).
