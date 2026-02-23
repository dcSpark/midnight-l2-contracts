# decoder-rs

`decoder-rs` is a Rust CLI for interacting with Midnight Bridge contracts on local or remote Midnight networks.

- **decode**: Reads and prints Bridge contract state from the indexer (pure Rust).
- **commit-batch** / **finalize-batch**: Commit and finalize batches by **delegating to the TypeScript bridge-cli**. The pure-Rust path for commit/finalize does not work; these commands spawn the refactored bridge-cli (TS) subprocess with the same env and args so you can test the TS-from-Rust flow.
  - `commit-batch` now builds a mock `BatchPublicDataV1Full`, derives `batchHash` from it, and writes the full batch to `.mock-batches/latest.json`.
  - `finalize-batch` now reads `.mock-batches/latest.json` and uses that payload to construct finalize inputs.
- **deposit**: Delegates to TypeScript `bridge-cli deposit` (calls `depositNIGHTUnshielded`).
- **set-verifier-set**: Delegates to TypeScript `bridge-cli set-verifier-set`.
- **relay-withdraw-night-with-proof**: Delegates to TypeScript `bridge-cli relay-withdraw-night-with-proof`.
- **claim-l1-withdrawal**: Delegates to TypeScript `bridge-cli claim-l1-withdrawal-unshielded`.
- **test-withdraw**: End-to-end withdrawal workflow orchestration in Rust; low-level circuit calls are delegated to the TypeScript bridge-cli.

## Prerequisites

- Rust toolchain (stable, with `cargo`)
- For **decode** only: running indexer GraphQL endpoint (default `http://127.0.0.1:8088/api/v3/graphql`)
- For **commit-batch** / **finalize-batch**: Node.js with `npx` and `tsx` (the TS bridge-cli is run as a subprocess). Same Midnight services as the bridge-cli (node WS, indexer, proof server, wallet seed). Run from `bridge-cli/decoder-rs` so the parent directory is the bridge-cli package root, or set `BRIDGE_CLI_DIR` to that path.

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

## Environment Variables

- `BRIDGE_CONTRACT_ADDRESS`: Bridge contract address, 64 hex chars
- `INDEXER_HTTP`: indexer GraphQL endpoint
- `MIDNIGHT_NODE_WS`: Midnight node WS endpoint
- `PROOF_SERVER`: proof server endpoint
- `FUNDING_SEED`: wallet seed (or mnemonic) used for transaction funding
- `BRIDGE_CLI_DIR`: optional; directory containing the bridge-cli package (default: parent of decoder-rs)
- `BRIDGE_ARTIFACTS`: path containing Bridge `keys/` and `zkir/`
- `SIGNATURE_MAX_NONCE`: max nonce scan depth for signature generation (passed to TS)

You can also pass these as CLI flags (`--contract`, `--indexer`, `--node-ws`, and so on).

## Troubleshooting

- If **commit-batch** or **finalize-batch** fails with "failed to run bridge-cli", ensure Node.js, `npx`, and `tsx` are installed and that you are running from `bridge-cli/decoder-rs` (or set `BRIDGE_CLI_DIR`).
