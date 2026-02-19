# decoder-rs

`decoder-rs` is a Rust CLI for interacting with Midnight Bridge contracts on local or remote Midnight networks.

- **decode**: Reads and prints Bridge contract state from the indexer (pure Rust).
- **commit-batch** / **finalize-batch**: Commit and finalize batches by **delegating to the TypeScript bridge-cli**. The pure-Rust path for commit/finalize does not work; these commands spawn the refactored bridge-cli (TS) subprocess with the same env and args so you can test the TS-from-Rust flow.

## Prerequisites

- Rust toolchain (stable, with `cargo`)
- For **decode** only: running indexer GraphQL endpoint (default `http://127.0.0.1:8088/api/v3/graphql`)
- For **commit-batch** / **finalize-batch**: Node.js with `npx` and `tsx` (the TS bridge-cli is run as a subprocess). Same Midnight services as the bridge-cli (node WS, indexer, proof server, wallet seed). Run from `bridge-cli/decoder-rs` so the parent directory is the bridge-cli package root, or set `BRIDGE_CLI_DIR` to that path.
- **dry-run** for commit-batch/finalize-batch: Bridge artifacts at `bridge-contract/dist/managed/Bridge` (for planning only; submit path uses TS).

## Commands

Run from `bridge-cli/decoder-rs`:

```bash
cargo run -- decode
```

```bash
cargo run -- commit-batch [--dry-run]
```

```bash
cargo run -- finalize-batch [--dry-run]
```

With `--dry-run`, the Rust code builds the planned call and prints it (no Node required). Without `--dry-run`, the commands invoke the TypeScript bridge-cli to build, prove, and submit the transaction.

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

## Environment Variables

- `BRIDGE_CONTRACT_ADDRESS`: Bridge contract address, 64 hex chars
- `INDEXER_HTTP`: indexer GraphQL endpoint
- `MIDNIGHT_NODE_WS`: Midnight node WS endpoint
- `PROOF_SERVER`: proof server endpoint
- `FUNDING_SEED`: wallet seed (or mnemonic) used for transaction funding
- `BRIDGE_CLI_DIR`: optional; directory containing the bridge-cli package (default: parent of decoder-rs)
- `BRIDGE_ARTIFACTS`: for dry-run only; path containing Bridge `keys/` and `zkir/`
- `SIGNATURE_MAX_NONCE`: max nonce scan depth for signature generation (passed to TS)

You can also pass these as CLI flags (`--contract`, `--indexer`, `--node-ws`, and so on).

## Troubleshooting

- If **commit-batch** or **finalize-batch** fails with "failed to run bridge-cli", ensure Node.js, `npx`, and `tsx` are installed and that you are running from `bridge-cli/decoder-rs` (or set `BRIDGE_CLI_DIR`).
- For **dry-run** only: if you see `UnsupportedBlockVersion(...)` when building the plan, the midnight-node-toolkit revision may not match your node runtime; use the TS path (no `--dry-run`) to submit.
