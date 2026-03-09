# Test: depositNIGHTUnshielded cost diagnostics

This document gives **complete instructions** to run the time-to-dismiss cost diagnostic for the Bridge contract's `depositNIGHTUnshielded` circuit.

The test:

1. Constructs a Bridge `ContractState` with a configurable number of `l1ToL2Deposits` entries (Rust state builder, no chain needed).
2. Generates a `depositNIGHTUnshielded` intent via `midnight-node-toolkit generate-intent circuit`.
3. Wraps the intent into a minimal `Transaction` and runs `tx.cost()` with real-network ledger parameters.
4. Reports detailed cost diagnostics (actual cost, allowed time-to-dismiss, tx size).

---

## Prerequisites

1. **`midnight-node`** must be present at the repo root (as a submodule or clone):

```bash
# If not already present:
git submodule update --init midnight-node
```

2. **Build `midnight-node-toolkit`:**

```bash
cd midnight-node
cargo build -p midnight-node-toolkit --release
```

The binary will be at `midnight-node/target/release/midnight-node-toolkit`.

3. **Build toolkit-js:**

```bash
cd midnight-node/util/toolkit-js
npm install && npm run build
```

4. **Build Bridge contract artifacts** (if not already built):

```bash
cd bridge-contract
npm run compact && npm run build
```

This produces `bridge-contract/dist/managed/Bridge/`.

5. **Install bridge-cli npm dependencies** (for the toolkit config):

```bash
cd bridge-cli
npm install
```

---

## Running the test

A single `cargo test` command runs the entire pipeline. With `midnight-node` present at the repo root you only need to set two things: the gate variable and the toolkit binary path:

```bash
cd bridge-cli/decoder-rs

RUN_AUTOMATED_TTD_TEST=1 \
TOOLKIT_BIN=../../midnight-node/target/release/midnight-node-toolkit \
NUM_DEPOSITS=500 \
cargo test automated_deposit_unshielded_time_to_dismiss -- --nocapture
```

That's it. Everything else is derived automatically from the repo layout.

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `RUN_AUTOMATED_TTD_TEST` | Yes | - | Set to `1` to enable the test |
| `TOOLKIT_BIN` | No | `midnight-node-toolkit` (on PATH) | Path to the toolkit binary |
| `MIDNIGHT_NODE` | No | `midnight-node/` (repo root) | Path to the midnight-node checkout |
| `TOOLKIT_JS_PATH` | No | `$MIDNIGHT_NODE/util/toolkit-js` | Path to toolkit-js directory |
| `BRIDGE_ARTIFACTS` | No | `bridge-contract/dist/managed/Bridge` | Compiled Bridge artifact directory |
| `BRIDGE_CONFIG` | No | `bridge-cli/toolkit-config/contract.config.ts` | Bridge contract config for toolkit-js |
| `CONTRACT_ADDRESS` | No | `000...0001` (dummy) | Contract address, 64 hex chars |
| `COIN_PUBLIC` | No | `000...0000` (64 zeros) | Coin public key for intent generation |
| `NUM_DEPOSITS` | No | `500` | Number of synthetic `l1ToL2Deposits` entries |
| `EXPECT_TTD_FAILURE` | No | `0` | Set to `1` to assert `OutsideTimeToDismiss`; otherwise the test reports diagnostics and passes |
| `MIN_TIME_TO_DISMISS_PS` | No | `15000000000000` (15s) | Override min_time_to_dismiss in picoseconds |
| `TIME_TO_DISMISS_PER_BYTE_PS` | No | `2000000` (2us) | Override time_to_dismiss_per_byte in picoseconds |

### About `CONTRACT_ADDRESS`

The contract address is embedded into the generated intent but is **not validated** against any ledger state by `generate-intent`. Any valid 64-character hex string works. The test defaults to `000...0001` (63 zeros followed by `1`).

### What the test does

1. Builds `ContractState` with `NUM_DEPOSITS` synthetic deposit entries using the Rust state builder (`bridge/state_builder.rs`).
2. Writes the state to a temp file (`state.bin`).
3. Writes `{"privateState":0}` to a temp file (`private_state.json`).
4. Calls `midnight-node-toolkit generate-intent circuit` with the Bridge config (`bridge-cli/toolkit-config/contract.config.ts`), the state file, and `depositNIGHTUnshielded` circuit args to produce `intent.bin`.
5. Deserializes the intent in Rust, wraps it in a minimal `Transaction`, and runs `tx.cost(&params, true)`.
6. Reports cost diagnostics: actual cost, allowed time-to-dismiss, tx size, synthetic cost breakdown.
7. If `EXPECT_TTD_FAILURE=1`, asserts `OutsideTimeToDismiss`; otherwise passes regardless of the cost check result.

---

## Gas scaling results

Cost of a `depositNIGHTUnshielded` transaction under real-network `INITIAL_PARAMETERS` (`min_time_to_dismiss = 15s`, `time_to_dismiss_per_byte = 2us/byte`):

| Deposits | cost_to_dismiss | allowed_time | tx size | compute_time | read_time |
|----------|----------------|--------------|---------|-------------|-----------|
| 1 | 10.387ms | 15.000ms | 1369 B | 10.387ms | 6.681ms |
| 100 | 10.728ms | 15.000ms | 1391 B | 10.728ms | 6.885ms |
| 500 | 10.833ms | 15.000ms | 1396 B | 10.833ms | 6.987ms |
| 1,000 | 10.865ms | 15.000ms | 1396 B | 10.865ms | 6.987ms |
| 5,000 | 10.941ms | 15.000ms | 1396 B | 10.941ms | 7.089ms |

### Key findings

- **Cost scales logarithmically** with deposit count. The Compact circuit inserts one entry into the `l1ToL2Deposits` map -- cost is `O(log2(map_size))`, not `O(n)`.
- **Transaction size is constant** (~1.4 KB). The map entries are in the contract state, not the transaction.
- **15s minimum dominates**: the real `min_time_to_dismiss` (15s) is ~1,400x larger than the actual cost (~10.9ms at 5,000 deposits). The cost would need to grow ~1,400x to breach this limit.
- **time_to_dismiss is not the bottleneck** for `depositNIGHTUnshielded` under current parameters. If deposits are failing on a real network, the cause is elsewhere (e.g., proof generation time, network congestion, or a different error).

To force a failure for testing purposes, you can tighten the limits:

```bash
RUN_AUTOMATED_TTD_TEST=1 \
TOOLKIT_BIN=../../midnight-node/target/release/midnight-node-toolkit \
NUM_DEPOSITS=500 \
MIN_TIME_TO_DISMISS_PS=0 \
TIME_TO_DISMISS_PER_BYTE_PS=0 \
EXPECT_TTD_FAILURE=1 \
cargo test automated_deposit_unshielded_time_to_dismiss -- --nocapture
```

---

## Bridge contract config

The config file at `bridge-cli/toolkit-config/contract.config.ts` wires the compiled Bridge contract to its witnesses for toolkit-js. It:

- Imports the Bridge `Contract` from `bridge-contract` (resolved via the monorepo's `node_modules`).
- Provides the three witness implementations (`userPubKey`, `indexBits`, `signerBitmapBits`).
- Points `withCompiledFileAssets` to `bridge-contract/dist/managed/Bridge` (overridable via `BRIDGE_MANAGED_DIR` env var).

---

## Rust state builder

The state builder at `bridge-cli/decoder-rs/src/bridge/state_builder.rs` constructs a `ContractState<DefaultDB>` with a configurable number of `l1ToL2Deposits` entries. No chain, no JS needed.

Standalone roundtrip tests (always runnable, no external deps):

```bash
cd bridge-cli/decoder-rs
cargo test build_state_with_many_deposits_and_verify_roundtrip
cargo test serialize_bridge_state_to_file_roundtrip
```

## Summary

The transaction under test is the **same** as a real Bridge `depositNIGHTUnshielded` call (same circuit, same artifact, same intent shape); the input state has a configurable number of `l1ToL2Deposits` entries.

Under real-network parameters, `time_to_dismiss` is not a bottleneck for this circuit. The 15s minimum limit vastly exceeds the ~11ms actual cost even at 5,000 pre-existing deposits. The test serves as a diagnostic/benchmark tool: run it with different `NUM_DEPOSITS` values and custom limits to explore cost behavior.
