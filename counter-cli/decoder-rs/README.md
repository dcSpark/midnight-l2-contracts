# decoder-rs

`decoder-rs` is a Rust CLI for interacting with Midnight Bridge contracts on local or remote Midnight networks.
It supports:

- decoding Bridge contract state from the indexer
- preparing and submitting `commitBatch` calls
- preparing and submitting `finalizeBatch` calls

## Prerequisites

- Rust toolchain (stable, with `cargo`)
- running Midnight services:
  - node WebSocket endpoint (default `ws://127.0.0.1:9944`)
  - indexer GraphQL endpoint (default `http://127.0.0.1:8088/api/v3/graphql`)
  - proof server endpoint (default `http://127.0.0.1:6300`) unless using `--local-prover`
- Bridge artifacts at `counter-contract/dist/managed/Bridge` (contains `keys/` and `zkir/`)

## Commands

Run from `counter-cli/decoder-rs`:

```bash
cargo run -- decode
```

```bash
cargo run -- commit-batch [--dry-run]
```

```bash
cargo run -- finalize-batch [--dry-run]
```

## Local Network Examples

Example decode against local indexer + explicit contract:

```bash
INDEXER_HTTP="http://127.0.0.1:8088/api/v3/graphql" \
BRIDGE_CONTRACT_ADDRESS="<64_hex_bridge_address>" \
cargo run -- decode
```

Dry-run `commitBatch` with explicit artifact path:

```bash
INDEXER_HTTP="http://127.0.0.1:8088/api/v3/graphql" \
MIDNIGHT_NODE_WS="ws://127.0.0.1:9944" \
BRIDGE_CONTRACT_ADDRESS="<64_hex_bridge_address>" \
BRIDGE_ARTIFACTS="../counter-contract/src/managed/Bridge" \
cargo run -- commit-batch --dry-run
```

Submit `finalizeBatch` using remote prover:

```bash
INDEXER_HTTP="http://127.0.0.1:8088/api/v3/graphql" \
MIDNIGHT_NODE_WS="ws://127.0.0.1:9944" \
PROOF_SERVER="http://127.0.0.1:6300" \
BRIDGE_CONTRACT_ADDRESS="<64_hex_bridge_address>" \
FUNDING_SEED="<wallet_seed_or_mnemonic>" \
BRIDGE_ARTIFACTS="../counter-contract/src/managed/Bridge" \
cargo run -- finalize-batch
```

## Environment Variables

- `BRIDGE_CONTRACT_ADDRESS`: Bridge contract address, 64 hex chars
- `INDEXER_HTTP`: indexer GraphQL endpoint
- `MIDNIGHT_NODE_WS`: Midnight node WS endpoint
- `PROOF_SERVER`: proof server endpoint
- `FUNDING_SEED`: wallet seed used for transaction funding
- `BRIDGE_ARTIFACTS`: path containing Bridge `keys/` and `zkir/`
- `FETCH_CONCURRENCY`: history fetch concurrency for transaction context
- `SIGNATURE_MAX_NONCE`: max nonce scan depth for signature generation

You can also pass these as CLI flags (`--contract`, `--indexer`, `--node-ws`, and so on).

## Troubleshooting

- If `commit-batch` or `finalize-batch` fails with `UnsupportedBlockVersion(...)`, the
  `midnight-node-toolkit` metadata used by this crate does not yet support your node runtime
  version. In that case, use `--dry-run` for call data generation and update toolkit dependencies
  to a runtime-compatible revision before submitting transactions.
