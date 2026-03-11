# Bridge circuit time-to-dismiss cost tests

This document gives **complete instructions** to run time-to-dismiss cost diagnostics for all feasible Bridge contract circuits.

The test:

1. Constructs a Bridge `ContractState` with configurable population of all storage fields (Rust state builder, no chain needed).
2. For each selected circuit, generates an intent via `midnight-node-toolkit generate-intent circuit`.
3. Wraps each intent into a minimal `Transaction` and runs the cost model with real-network ledger parameters.
4. Computes a **realistic allowed time** by adding an estimated zswap proof overhead to `est_size` (since real proven transactions include fee coin proofs that the minimal test transaction omits).
5. Reports detailed cost diagnostics and a summary table.

---

## Prerequisites

1. **`midnight-node`** must be present at the repo root (as a submodule or clone):

```bash
git submodule update --init midnight-node
```

2. **Build `midnight-node-toolkit`:**

```bash
cd midnight-node
cargo build -p midnight-node-toolkit --release
```

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

The `npm run compact` step automatically patches the generated `index.d.ts` to inline type aliases that the `compact-js-command` argument parser cannot resolve (see [Patches](#patches) below).

5. **Install bridge-cli npm dependencies** (for the toolkit config):

```bash
cd bridge-cli
npm install
```

6. **Apply the BigInt runtime patch:**

```bash
bash bridge-cli/scripts/patch-compact-js-bigint.sh
```

This fixes a BigInt parsing bug in `compact-js-command` (re-apply after `npm install` in toolkit-js).

The module unification patch (`patch-compact-runtime-charged-state.sh`) is applied and removed **automatically** by the test. It creates temporary symlinks that conflict with the normal `bridge-cli deploy` command, so they are cleaned up when the test finishes (including on failure). If you need to manage them manually:

```bash
bash bridge-cli/scripts/patch-compact-runtime-charged-state.sh            # apply
bash bridge-cli/scripts/patch-compact-runtime-charged-state.sh --unpatch  # remove
```

---

## Running the test

```bash
cd bridge-cli/decoder-rs

RUN_AUTOMATED_TTD_TEST=1 \
TOOLKIT_BIN=../../midnight-node/target/release/midnight-node-toolkit \
cargo test automated_deposit_unshielded_time_to_dismiss -- --nocapture
```

By default this runs **all 11 L1 circuits** (zero SKIPs) with 500 entries per collection field and a 12,576-byte zswap overhead (modelling a realistic proven tx: 1 fee input + 1 change output + 1 dust spend proof). Use `CIRCUITS` to select specific ones.

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
| `COIN_PUBLIC` | No | `000...0000` (64 zeros) | Coin public key (used as `owner` and for auth checks) |
| `NUM_ENTRIES` | No | `500` | Entries per collection field (deposits, sequencers, etc.) |
| `CIRCUITS` | No | all feasible | Comma-separated circuit names to test |
| `EXPECT_TTD_FAILURE` | No | `0` | Set to `1` to assert `OutsideTimeToDismiss` |
| `MIN_TIME_TO_DISMISS_PS` | No | `15000000000` (15ms) | Override min_time_to_dismiss in picoseconds |
| `ZSWAP_SIZE_OVERHEAD` | No | `12576` | Extra bytes for realistic proven-tx size (1 input + 1 output + 1 dust proof); set to `0` for strictest minimal-tx check |
| `TIME_TO_DISMISS_PER_BYTE_PS` | No | `2000000` (2us) | Override time_to_dismiss_per_byte in picoseconds |

### Examples

Test only `depositNIGHTUnshielded` with 1000 entries:

```bash
RUN_AUTOMATED_TTD_TEST=1 \
TOOLKIT_BIN=../../midnight-node/target/release/midnight-node-toolkit \
NUM_ENTRIES=1000 \
CIRCUITS=depositNIGHTUnshielded \
cargo test automated_deposit_unshielded_time_to_dismiss -- --nocapture
```

Test the hard circuits (Merkle proof + threshold signature validation):

```bash
RUN_AUTOMATED_TTD_TEST=1 \
TOOLKIT_BIN=../../midnight-node/target/release/midnight-node-toolkit \
CIRCUITS=relayWithdrawNIGHTWithProof,finalizeBatch \
cargo test automated_deposit_unshielded_time_to_dismiss -- --nocapture
```

Test admin circuits with tight limits to force failure:

```bash
RUN_AUTOMATED_TTD_TEST=1 \
TOOLKIT_BIN=../../midnight-node/target/release/midnight-node-toolkit \
CIRCUITS=addSequencer,removeSequencer,addFinalizer,removeFinalizer \
MIN_TIME_TO_DISMISS_PS=0 \
TIME_TO_DISMISS_PER_BYTE_PS=0 \
EXPECT_TTD_FAILURE=1 \
cargo test automated_deposit_unshielded_time_to_dismiss -- --nocapture
```

---

## Circuit matrix

### Cost-checked (11 circuits)

| Circuit | Category | State requirements |
|---|---|---|
| `depositNIGHTUnshielded` | Easy | None (assertions mostly commented out) |
| `addSequencer` | Easy | `owner == COIN_PUBLIC` |
| `removeSequencer` | Easy | `owner == COIN_PUBLIC` |
| `addFinalizer` | Easy | `owner == COIN_PUBLIC` |
| `removeFinalizer` | Easy | `owner == COIN_PUBLIC` |
| `setVerifierSet` | Easy | `owner == COIN_PUBLIC` |
| `claimL1WithdrawalUnshielded` | Medium | `pendingWithdrawals[recipient] >= amount` |
| `claimL1FeesUnshielded` | Medium | `owner == COIN_PUBLIC` + `feeVault >= amount` |
| `commitBatch` | Medium | Uses per-circuit state override: `lastCommittedBatchIndex == lastFinalizedBatchIndex`, `COIN_PUBLIC` in sequencers set, `parentBatchHash == lastFinalizedBatchHash` |
| `relayWithdrawNIGHTWithProof` | Hard | Valid depth-16 Merkle proof against a `withdrawRoot` stored in state. Proof is computed in Rust using `bridge/merkle.rs` (extracted from `test_withdraw.rs`). |
| `finalizeBatch` | Hard | Valid threshold signatures over `BatchPublicDataV1Full` verified against `verifierSet` in state. Uses per-circuit state override: `lastCommittedBatchIndex = lastFinalizedBatchIndex + 1`. `COIN_PUBLIC` must be in both `sequencers` and `finalizers` sets. Requires module unification patch (see below). **Tightest circuit**: ~15.4ms cost vs 15ms minimum. Passes with the default 12,576-byte zswap overhead; reports EXCEEDS with `ZSWAP_SIZE_OVERHEAD=0`. |

### Excluded (1 circuit)

| Circuit | Reason |
|---|---|
| `withdrawNIGHT` | L2 Gateway circuit -- calls `GW_debit()` which debits from shielded token balances on L2. Not an L1 contract transaction, irrelevant for L1 time-to-dismiss testing. |

### Per-circuit state

The test builds a **base state** that satisfies most circuits: `owner = COIN_PUBLIC`, all collection fields populated, `verifierSet` with derived public keys, a specific `withdrawRoot` from a computed Merkle tree, and `COIN_PUBLIC` added to both `sequencers` and `finalizers` sets.

Circuits with conflicting state requirements use `state_override` to rebuild the state. `commitBatch` uses this to set `lastCommittedBatchIndex == lastFinalizedBatchIndex`, while the base state sets `lastCommittedBatchIndex = lastFinalizedBatchIndex + 1` (needed for `finalizeBatch`).

---

## Patches

Three patches are required:

### 1. Type alias inlining (`bridge-contract/scripts/patch-index-dts.sh`)

The `compact-js-command` argument parser resolves types from the `index.d.ts` AST but cannot follow named type aliases (`TypeReference` nodes). Only `Uint8Array` is handled as a TypeReference; all others (`L1_WithdrawProof16`, `L1_BatchPublicDataV1Full`, `Signature`) return `undefined`.

The patch inlines these three type aliases in the `ImpureCircuits` type in `src/managed/Bridge/contract/index.d.ts`. This is automatically run by `npm run compact` in the `bridge-contract` package.

TypeScript consumers are unaffected -- TS resolves both named and inline types identically.

### 2. BigInt quote stripping (`bridge-cli/scripts/patch-compact-js-bigint.sh`)

When `compact-js-command` parses an `ArrayType` containing `TypeLiteral` elements, it double-stringifies field values via `JSON5.stringify`. String values get single-quoted (`'value'`), and the `BigIntKeyword` handler calls `BigInt("'value'")` which fails. The `StringKeyword` and `Uint8Array` handlers already strip quotes using the `quotedStrings` flag, but `BigIntKeyword` doesn't.

The patch adds the same `quotedStrings` cleanup to the BigInt handler. This must be re-applied after any `npm install` in `midnight-node/util/toolkit-js`.

### 3. Module unification (`bridge-cli/scripts/patch-compact-runtime-charged-state.sh`)

The compiled Bridge contract (loaded at `bridge-contract/dist/managed/Bridge/contract/index.js`) resolves `@midnight-ntwrk/compact-runtime` and `@midnight-ntwrk/onchain-runtime-v2` from the workspace-root `node_modules/`, while `toolkit-js` has its own copies. These are separate module instances with separate class definitions, so `instanceof` checks fail across modules.

The `finalizeBatch` circuit triggers this because its JubJub curve operations (`ecMul`, `ecAdd`, `ecMulGenerator`) use WASM code paths that strictly enforce `instanceof ChargedState`. Simpler circuits only use the query engine which is more tolerant.

The patch creates symlinks at `bridge-contract/node_modules/@midnight-ntwrk/{compact-runtime,onchain-runtime-v2}` pointing to the toolkit-js copies, so all code shares a single module instance. Must be re-run if the symlinks are deleted. **While the symlinks are in place, the normal `bridge-cli deploy` command will fail** with `expected instance of ContractMaintenanceAuthority`. Remove them after running cost tests:

```bash
bash bridge-cli/scripts/patch-compact-runtime-charged-state.sh            # apply
bash bridge-cli/scripts/patch-compact-runtime-charged-state.sh --unpatch  # remove
```

---

## State builder

The state builder at `bridge-cli/decoder-rs/src/bridge/state_builder.rs` constructs a `ContractState<DefaultDB>` with configurable population of **all** storage fields:

- `l1ToL2Deposits`, `sequencers`, `finalizers`, `withdrawRoots`, `messageRollingHashes`, `messageTimestamps`, `executedL2ToL1Messages`, `pendingWithdrawals`, `l2GatewayBalances`
- Scalar values: `owner`, `lockedNIGHT`, `feeVault`, `lastFinalizedBatchHash`, `lastFinalizedStateRoot`, `lastCommittedBatchHash`
- Crypto fields: `verifierSet` (3 public key points), `signatureThreshold`
- Batch tracking: `lastCommittedBatchIndex` (independent of `lastFinalizedBatchIndex`)
- Explicit entries: `specificWithdrawRoots` (for Merkle proof verification)
- Role membership: `extraSequencers`, `extraFinalizers` (added to synthetic entries)

Standalone roundtrip tests (always runnable, no external deps):

```bash
cd bridge-cli/decoder-rs
cargo test build_state_with_many_deposits_and_verify_roundtrip
cargo test serialize_bridge_state_to_file_roundtrip
```

---

## Gas scaling results (depositNIGHTUnshielded)

Cost under real-network `INITIAL_PARAMETERS` (`min_time_to_dismiss = 15ms`, `time_to_dismiss_per_byte = 2us/byte`):

| Deposits | cost_to_dismiss | allowed_time | tx size | compute_time | read_time |
|----------|----------------|--------------|---------|-------------|-----------|
| 1 | 10.387ms | 15.000ms | 1369 B | 10.387ms | 6.681ms |
| 100 | 10.728ms | 15.000ms | 1391 B | 10.728ms | 6.885ms |
| 500 | 10.833ms | 15.000ms | 1396 B | 10.833ms | 6.987ms |
| 1,000 | 10.865ms | 15.000ms | 1396 B | 10.865ms | 6.987ms |
| 5,000 | 10.941ms | 15.000ms | 1396 B | 10.941ms | 7.089ms |

**Key findings:**

- Cost scales as `O(log2(map_size))` -- one map insert per circuit call.
- Transaction size is constant (~1.4 KB); map entries live in contract state, not the tx.
- The 15ms minimum limit is ~1.4x larger than the actual cost at any tested scale. The `time_to_dismiss` limit is unreachable for this circuit under current parameters.
