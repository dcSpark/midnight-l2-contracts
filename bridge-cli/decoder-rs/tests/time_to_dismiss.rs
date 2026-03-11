//! Time-to-dismiss (cost) tests for Bridge contract call transactions.
//!
//! These tests assert that the ledger's cost check correctly raises
//! `FeeCalculationError::OutsideTimeToDismiss` when transactions exceed
//! the allowed time-to-dismiss limit.
//!
//! Use only types from the ledger-7.0.1 dependency tree (base_crypto,
//! midnight_storage, transient_crypto) so they match midnight_ledger.

use std::path::{Path, PathBuf};
use std::process::Command;

use base_crypto::cost_model::CostDuration;
use base_crypto::signatures::{Signature, VerifyingKey};
use midnight_ledger::error::FeeCalculationError;
use midnight_ledger::structure::{
    ClaimKind, ClaimRewardsTransaction, Intent, LedgerParameters, ProofPreimageMarker,
    StandardTransaction, Transaction, TransactionLimits, INITIAL_PARAMETERS,
};
use midnight_storage::DefaultDB;
use midnight_storage::storage::HashMap;
use serialize::{tagged_deserialize, tagged_serialize};
use transient_crypto::commitment::{Pedersen, PedersenRandomness};

use decoder_rs::bridge::state_builder::{
    build_bridge_state, pending_withdrawal_recipient, serialize_bridge_state_to_file,
    BridgeStateConfig,
};
use decoder_rs::commands::decode::{decode_bridge_ledger, deserialize_contract_state};

/// Build LedgerParameters with very strict time-to-dismiss limits so that
/// any non-trivial transaction fails the cost check.
fn strict_ledger_parameters() -> LedgerParameters {
    let strict_limits = TransactionLimits {
        transaction_byte_limit: INITIAL_PARAMETERS.limits.transaction_byte_limit,
        time_to_dismiss_per_byte: CostDuration::from_picoseconds(0),
        min_time_to_dismiss: CostDuration::from_picoseconds(0),
        block_limits: INITIAL_PARAMETERS.limits.block_limits,
        block_withdrawal_minimum_multiple: INITIAL_PARAMETERS.limits.block_withdrawal_minimum_multiple,
    };
    LedgerParameters {
        limits: strict_limits,
        ..INITIAL_PARAMETERS
    }
}

/// Extra bytes to add to est_size when computing the allowed time-to-dismiss.
/// Models a realistic proven tx with fee coins: 1 zswap input proof (4832) +
/// 1 zswap output proof (4832) + 1 dust spend proof (2912). These are the same
/// constants used by the ledger's est_size() formula in structure.rs.
/// Set ZSWAP_SIZE_OVERHEAD=0 for the strictest possible check (minimal tx).
const DEFAULT_ZSWAP_OVERHEAD: u64 = 4_832 + 4_832 + 2_912; // 12,576 bytes

fn zswap_size_overhead() -> u64 {
    std::env::var("ZSWAP_SIZE_OVERHEAD")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(DEFAULT_ZSWAP_OVERHEAD)
}

/// Build LedgerParameters from env-var overrides or fall back to real-network defaults.
///
/// Supported env vars (values in picoseconds):
///   - `MIN_TIME_TO_DISMISS_PS`       (default: from INITIAL_PARAMETERS, ~15ms)
///   - `TIME_TO_DISMISS_PER_BYTE_PS`  (default: from INITIAL_PARAMETERS, ~2us/byte)
fn ledger_parameters_from_env() -> LedgerParameters {
    let min_ttd = std::env::var("MIN_TIME_TO_DISMISS_PS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .map(CostDuration::from_picoseconds)
        .unwrap_or(INITIAL_PARAMETERS.limits.min_time_to_dismiss);

    let per_byte = std::env::var("TIME_TO_DISMISS_PER_BYTE_PS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .map(CostDuration::from_picoseconds)
        .unwrap_or(INITIAL_PARAMETERS.limits.time_to_dismiss_per_byte);

    let limits = TransactionLimits {
        min_time_to_dismiss: min_ttd,
        time_to_dismiss_per_byte: per_byte,
        ..INITIAL_PARAMETERS.limits
    };
    LedgerParameters {
        limits,
        ..INITIAL_PARAMETERS
    }
}

/// Print cost diagnostics for a transaction.
///
/// Returns `(cost_to_dismiss, allowed)` so the caller can decide pass/fail.
/// When `zswap_overhead > 0`, the allowed time accounts for the extra proof
/// bytes that a real proven transaction would include.
fn print_cost_diagnostics(
    tx: &TxType,
    params: &LedgerParameters,
    label: &str,
    zswap_overhead: u64,
) -> (CostDuration, CostDuration) {
    let cost_to_dismiss = tx.time_to_dismiss(&params.cost_model);
    let full_cost = tx.cost(params, false).expect("cost(enforce=false) should succeed");

    let est_size = full_cost.block_usage;
    let effective_size = est_size + zswap_overhead;
    let allowed = CostDuration::max(
        params.limits.time_to_dismiss_per_byte * effective_size,
        params.limits.min_time_to_dismiss,
    );

    eprintln!("\n=== Cost Diagnostics: {} ===", label);
    eprintln!("  est_size:                  {} bytes", est_size);
    if zswap_overhead > 0 {
        eprintln!("  zswap_overhead:            {} bytes", zswap_overhead);
        eprintln!("  effective_size:            {} bytes", effective_size);
    }
    eprintln!("  cost_to_dismiss (actual):  {:?}", cost_to_dismiss);
    eprintln!("  allowed_time_to_dismiss:   {:?}", allowed);
    eprintln!("  min_time_to_dismiss param: {:?}", params.limits.min_time_to_dismiss);
    eprintln!("  per_byte param:            {:?}", params.limits.time_to_dismiss_per_byte);
    eprintln!("  synthetic_cost:            {:?}", full_cost);
    if cost_to_dismiss > allowed {
        eprintln!("  VERDICT: EXCEEDS time-to-dismiss limit");
    } else {
        eprintln!("  VERDICT: WITHIN time-to-dismiss limit");
    }
    eprintln!("==========================================\n");

    (cost_to_dismiss, allowed)
}

/// A ClaimRewards transaction has non-zero cost; with strict parameters
/// it should fail the time-to-dismiss check.
#[test]
fn cost_check_rejects_claim_rewards_with_strict_params() {
    let params = strict_ledger_parameters();
    let tx: Transaction<(), (), Pedersen, DefaultDB> =
        Transaction::ClaimRewards(ClaimRewardsTransaction {
            network_id: "local-test".into(),
            value: 1_000_000,
            owner: VerifyingKey::default(),
            nonce: Default::default(),
            signature: (),
            kind: ClaimKind::Reward,
        });

    let result = tx.cost(&params, true);
    assert!(
        result.is_err(),
        "expected Err(OutsideTimeToDismiss) with strict params, got Ok"
    );
    let err = result.unwrap_err();
    assert!(
        matches!(err, FeeCalculationError::OutsideTimeToDismiss { .. }),
        "expected OutsideTimeToDismiss, got {:?}",
        err
    );
}

/// Run midnight-node-toolkit send-intent: produce a transaction file from
/// intent file(s) + compiled contract dir + source (genesis) file.
///
/// This builds a full transaction (including proof generation) and writes it
/// to `dest_file` in tagged-serialized binary format.
///
/// Returns the path to the produced transaction file, or an error if the toolkit fails.
pub fn run_toolkit_send_intent(
    toolkit_bin: &str,
    genesis_src_file: &Path,
    dest_file: &Path,
    intent_files: &[impl AsRef<Path>],
    compiled_contract_dirs: &[impl AsRef<Path>],
) -> Result<std::path::PathBuf, String> {
    let mut cmd = Command::new(toolkit_bin);
    cmd.arg("send-intent")
        .arg("--dust-warp")
        .arg("--src-file")
        .arg(genesis_src_file)
        .arg("--dest-file")
        .arg(dest_file)
        .arg("--to-bytes");
    for f in intent_files {
        cmd.arg("--intent-file").arg(f.as_ref());
    }
    for d in compiled_contract_dirs {
        cmd.arg("--compiled-contract-dir").arg(d.as_ref());
    }
    let cmd_dbg = format!("{:?}", cmd);
    let output = cmd
        .output()
        .map_err(|e| format!("failed to run toolkit: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "toolkit send-intent exited with {}\nRunning: {}\nstdout: {}\nstderr: {}",
            output.status, cmd_dbg, stdout, stderr
        ));
    }
    if !dest_file.exists() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "toolkit did not produce dest file\nRunning: {}\nstdout: {}\nstderr: {}",
            cmd_dbg, stdout, stderr
        ));
    }
    Ok(dest_file.to_path_buf())
}

/// Run midnight-node-toolkit generate-intent circuit: produce an intent file
/// from a contract config, on-chain state, private state, and circuit args.
///
/// Returns the path to the produced intent file, or an error.
pub fn run_toolkit_generate_intent(
    toolkit_bin: &str,
    config_path: &Path,
    toolkit_js_path: &Path,
    state_file: &Path,
    private_state_file: &Path,
    contract_address: &str,
    coin_public: &str,
    network: &str,
    output_intent: &Path,
    output_private_state: &Path,
    output_zswap_state: &Path,
    circuit_id: &str,
    call_args: &[&str],
) -> Result<PathBuf, String> {
    let mut cmd = Command::new(toolkit_bin);
    cmd.arg("generate-intent")
        .arg("circuit")
        .arg("-c")
        .arg(config_path)
        .arg("--toolkit-js-path")
        .arg(toolkit_js_path)
        .arg("--network")
        .arg(network)
        .arg("--coin-public")
        .arg(coin_public)
        .arg("--input-onchain-state")
        .arg(state_file)
        .arg("--input-private-state")
        .arg(private_state_file)
        .arg("--contract-address")
        .arg(contract_address)
        .arg("--output-intent")
        .arg(output_intent)
        .arg("--output-private-state")
        .arg(output_private_state)
        .arg("--output-zswap-state")
        .arg(output_zswap_state)
        .arg(circuit_id);
    for arg in call_args {
        cmd.arg(arg);
    }
    let cmd_dbg = format!("{:?}", cmd);
    let output = cmd
        .output()
        .map_err(|e| format!("failed to run toolkit generate-intent: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "toolkit generate-intent exited with {}\nRunning: {}\nstdout: {}\nstderr: {}",
            output.status, cmd_dbg, stdout, stderr
        ));
    }
    if !output_intent.exists() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "toolkit did not produce intent file\nRunning: {}\nstdout: {}\nstderr: {}",
            cmd_dbg, stdout, stderr
        ));
    }
    Ok(output_intent.to_path_buf())
}

/// Build a minimal Transaction wrapping a tagged-serialized intent file.
///
/// This avoids the need for `send-intent` (which requires the contract to be
/// deployed in the genesis ledger). The resulting transaction has the same cost
/// profile as one produced by `send-intent` since the cost comes from the
/// intent's transcript gas values and the serialized size.
type IntentType = Intent<Signature, ProofPreimageMarker, PedersenRandomness, DefaultDB>;
type TxType = Transaction<Signature, ProofPreimageMarker, PedersenRandomness, DefaultDB>;

pub fn transaction_from_intent_file(
    intent_path: &Path,
    network_id: &str,
) -> Result<TxType, String> {
    let bytes = std::fs::read(intent_path)
        .map_err(|e| format!("failed to read intent file: {}", e))?;
    let intent: IntentType = tagged_deserialize(bytes.as_slice())
        .map_err(|e| format!("deserialize intent: {:?}", e))?;

    let mut intents: HashMap<u16, IntentType, DefaultDB> = HashMap::new();
    intents = intents.insert(1u16, intent);

    Ok(Transaction::Standard(StandardTransaction {
        network_id: network_id.to_string(),
        intents,
        guaranteed_coins: None,
        fallible_coins: HashMap::new(),
        binding_randomness: PedersenRandomness::default(),
    }))
}

/// Deserialize a tagged-serialized transaction file and run cost check with strict params.
/// Asserts that the result is `Err(OutsideTimeToDismiss)`.
pub fn cost_check_tx_file_rejects_with_strict_params(tx_path: &Path) -> Result<(), String> {
    let bytes =
        std::fs::read(tx_path).map_err(|e| format!("failed to read tx file: {}", e))?;
    let tx: Transaction<(), (), Pedersen, DefaultDB> =
        tagged_deserialize(bytes.as_slice()).map_err(|e| format!("deserialize tx: {:?}", e))?;
    let params = strict_ledger_parameters();
    let result = tx.cost(&params, true);
    match result {
        Err(FeeCalculationError::OutsideTimeToDismiss { .. }) => Ok(()),
        Ok(_) => Err("expected Err(OutsideTimeToDismiss), got Ok".to_string()),
        Err(e) => Err(format!("expected OutsideTimeToDismiss, got {:?}", e)),
    }
}

/// Integration test: run toolkit send-intent (dry-run) then cost-check the produced tx
/// with strict params and assert OutsideTimeToDismiss.
///
/// Runs only when RUN_TOOLKIT_COST_TEST=1 and TOOLKIT_BIN (or midnight-node-toolkit),
/// GENESIS_FILE, INTENT_FILE, BRIDGE_ARTIFACTS are set; otherwise the test no-ops and passes.
#[test]
fn toolkit_tx_fails_cost_check_with_strict_params() {
    if std::env::var("RUN_TOOLKIT_COST_TEST").ok().as_deref() != Some("1") {
        return;
    }
    let toolkit_bin = std::env::var("TOOLKIT_BIN")
        .unwrap_or_else(|_| "midnight-node-toolkit".to_string());
    let genesis_file = match std::env::var("GENESIS_FILE") {
        Ok(p) => p,
        Err(_) => {
            eprintln!("GENESIS_FILE not set, skipping toolkit cost test");
            return;
        }
    };
    let intent_file = match std::env::var("INTENT_FILE") {
        Ok(p) => p,
        Err(_) => {
            eprintln!("INTENT_FILE not set, skipping toolkit cost test");
            return;
        }
    };
    let bridge_artifacts = match std::env::var("BRIDGE_ARTIFACTS") {
        Ok(p) => p,
        Err(_) => {
            eprintln!("BRIDGE_ARTIFACTS not set, skipping toolkit cost test");
            return;
        }
    };
    let genesis_path = Path::new(&genesis_file);
    let intent_path = Path::new(&intent_file);
    if !genesis_path.exists() {
        eprintln!("GENESIS_FILE path does not exist: {}", genesis_file);
        return;
    }
    if !intent_path.exists() {
        eprintln!("INTENT_FILE path does not exist: {}", intent_file);
        return;
    }
    let out_dir = std::env::temp_dir();
    let dest_file = out_dir.join("time_to_dismiss_toolkit_tx.mn");
    let dest_path = run_toolkit_send_intent(
        &toolkit_bin,
        genesis_path,
        &dest_file,
        &[intent_path],
        &[Path::new(&bridge_artifacts)],
    )
    .expect("toolkit send-intent should succeed");
    cost_check_tx_file_rejects_with_strict_params(&dest_path)
        .expect("cost check should reject with strict params");
}

/// Test: transaction that calls the Bridge contract's `depositNIGHTUnshielded` circuit
/// (L1Rollup.compact), with ledger state that has a sizeable `l1ToL2Deposits` mapping.
/// Asserts that the produced tx fails the cost check (OutsideTimeToDismiss) when using
/// strict ledger parameters.
///
/// The intent must be built from a state file where the Bridge's `l1ToL2Deposits` map
/// is pre-populated with many entries (see docs/time-to-dismiss-tests.md).
///
/// Runs only when RUN_DEPOSIT_UNSHIELDED_COST_TEST=1. Requires TOOLKIT_BIN, GENESIS_FILE,
/// INTENT_FILE (depositNIGHTUnshielded intent from state with many l1ToL2Deposits),
/// BRIDGE_ARTIFACTS.
#[test]
fn deposit_night_unshielded_tx_with_large_l1_to_l2_deposits_fails_cost_check() {
    if std::env::var("RUN_DEPOSIT_UNSHIELDED_COST_TEST").ok().as_deref() != Some("1") {
        return;
    }
    let toolkit_bin = std::env::var("TOOLKIT_BIN")
        .unwrap_or_else(|_| "midnight-node-toolkit".to_string());
    let genesis_file = match std::env::var("GENESIS_FILE") {
        Ok(p) => p,
        Err(_) => {
            eprintln!("GENESIS_FILE not set, skipping depositNIGHTUnshielded cost test");
            return;
        }
    };
    let intent_file = match std::env::var("INTENT_FILE") {
        Ok(p) => p,
        Err(_) => {
            eprintln!("INTENT_FILE not set (must be depositNIGHTUnshielded intent from state with sizeable l1ToL2Deposits)");
            return;
        }
    };
    let bridge_artifacts = match std::env::var("BRIDGE_ARTIFACTS") {
        Ok(p) => p,
        Err(_) => {
            eprintln!("BRIDGE_ARTIFACTS not set, skipping depositNIGHTUnshielded cost test");
            return;
        }
    };
    let genesis_path = Path::new(&genesis_file);
    let intent_path = Path::new(&intent_file);
    if !genesis_path.exists() {
        eprintln!("GENESIS_FILE path does not exist: {}", genesis_file);
        return;
    }
    if !intent_path.exists() {
        eprintln!("INTENT_FILE path does not exist: {}", intent_file);
        return;
    }
    let out_dir = std::env::temp_dir();
    let dest_file = out_dir.join("deposit_night_unshielded_tx.mn");
    let dest_path = run_toolkit_send_intent(
        &toolkit_bin,
        genesis_path,
        &dest_file,
        &[intent_path],
        &[Path::new(&bridge_artifacts)],
    )
    .expect("toolkit send-intent should succeed for depositNIGHTUnshielded intent");
    cost_check_tx_file_rejects_with_strict_params(&dest_path)
        .expect("cost check should reject depositNIGHTUnshielded tx with strict params when state has sizeable l1ToL2Deposits");
}

/// Build a Bridge ContractState with N deposits in Rust, serialize -> deserialize,
/// then decode with existing decode_bridge_ledger and verify the deposit count matches.
#[test]
fn build_state_with_many_deposits_and_verify_roundtrip() {
    let num = 500u64;
    let config = BridgeStateConfig { num_deposits: num, ..Default::default() };
    let state = build_bridge_state(&config);

    let mut buf = Vec::new();
    tagged_serialize(&state, &mut buf).expect("tagged_serialize should succeed");
    assert!(!buf.is_empty(), "serialized state should not be empty");

    let deserialized = deserialize_contract_state(&buf)
        .expect("deserialize_contract_state should succeed on builder output");

    let ledger = decode_bridge_ledger(&deserialized)
        .expect("decode_bridge_ledger should succeed on builder-produced state");

    assert_eq!(
        ledger.rollup.l1_to_l2_deposits.len() as u64,
        num,
        "decoded deposit count must match the configured num_deposits"
    );
    assert_eq!(
        ledger.rollup.next_cross_domain_message_index, num,
        "nextCrossDomainMessageIndex must equal num_deposits"
    );

    for i in 0..num {
        assert!(
            ledger.rollup.l1_to_l2_deposits.contains_key(&i),
            "deposit at index {} must be present",
            i
        );
    }
}

/// Verify that serialize_bridge_state_to_file produces a file that can be
/// deserialized and decoded back correctly.
#[test]
fn serialize_bridge_state_to_file_roundtrip() {
    let num = 10u64;
    let config = BridgeStateConfig { num_deposits: num, ..Default::default() };
    let state = build_bridge_state(&config);

    let dir = std::env::temp_dir().join("decoder_rs_state_builder_test");
    std::fs::create_dir_all(&dir).expect("create temp dir");
    let path = dir.join("test_state.bin");

    serialize_bridge_state_to_file(&state, &path)
        .expect("serialize_bridge_state_to_file should succeed");

    let bytes = std::fs::read(&path).expect("read state file");
    let deserialized = deserialize_contract_state(&bytes)
        .expect("deserialize_contract_state should succeed");
    let ledger = decode_bridge_ledger(&deserialized)
        .expect("decode_bridge_ledger should succeed");
    assert_eq!(ledger.rollup.l1_to_l2_deposits.len() as u64, num);

    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// Circuit registry: defines how to call each circuit and what state it needs
// ---------------------------------------------------------------------------

use decoder_rs::bridge::abi::BatchPublicDataV1Full;
use decoder_rs::bridge::merkle::{
    compute_index_bits, compute_merkle_root, compute_withdraw_leaf, generate_merkle_proof,
    hash_l2_to_l1_withdraw, WITHDRAW_TREE_DEPTH,
};
use decoder_rs::signatures::{
    build_signatures_json, derive_verifier_public_keys, DEFAULT_VERIFIER_SECRET_KEYS,
};
use num_bigint::BigUint;

/// Pre-computed data for the relayWithdrawNIGHTWithProof circuit.
struct RelayProofData {
    l2_sender: [u8; 32],
    l1_recipient: [u8; 32],
    amount: u128,
    nonce: u64,
    batch_index: u64,
    withdraw_root: [u8; 32],
    proof_siblings: Vec<[u8; 32]>,
    index_bits: Vec<bool>,
}

/// Pre-computed data for the finalizeBatch circuit.
struct FinalizeBatchData {
    bpd: BatchPublicDataV1Full,
    signatures_json: String,
    signer_bitmap: u8,
}

/// Context available to argument builders (both simple and hard circuits).
struct CircuitArgContext {
    #[allow(dead_code)]
    coin_public: String,
    relay_proof: Option<RelayProofData>,
    finalize_batch: Option<FinalizeBatchData>,
}

struct CircuitDef {
    name: &'static str,
    build_args: Box<dyn Fn(&CircuitArgContext) -> Vec<String> + Sync>,
    /// If set, override the base state config for this circuit.
    /// The closure receives the base config and returns a modified copy.
    state_override: Option<Box<dyn Fn(BridgeStateConfig) -> BridgeStateConfig + Sync>>,
}

const ALL_CIRCUIT_NAMES: &[&str] = &[
    "depositNIGHTUnshielded",
    "addSequencer",
    "removeSequencer",
    "addFinalizer",
    "removeFinalizer",
    "claimL1WithdrawalUnshielded",
    "claimL1FeesUnshielded",
    "commitBatch",
    "setVerifierSet",
    "relayWithdrawNIGHTWithProof",
    "finalizeBatch",
    // withdrawNIGHT excluded: L2 Gateway circuit (GW_debit), not an L1 transaction
];

fn build_circuit_registry() -> Vec<CircuitDef> {
    vec![
        CircuitDef {
            name: "depositNIGHTUnshielded",
            state_override: None,
            build_args: Box::new(|_ctx| {
                let l2_recipient = "ab".repeat(32);
                vec!["1000000".into(), l2_recipient, "100000".into(), "0".into()]
            }),
        },
        CircuitDef {
            name: "addSequencer",
            state_override: None,
            build_args: Box::new(|_ctx| vec!["dd".repeat(32)]),
        },
        CircuitDef {
            name: "removeSequencer",
            state_override: None,
            build_args: Box::new(|_ctx| vec!["dd".repeat(32)]),
        },
        CircuitDef {
            name: "addFinalizer",
            state_override: None,
            build_args: Box::new(|_ctx| vec!["ee".repeat(32)]),
        },
        CircuitDef {
            name: "removeFinalizer",
            state_override: None,
            build_args: Box::new(|_ctx| vec!["ee".repeat(32)]),
        },
        CircuitDef {
            name: "claimL1WithdrawalUnshielded",
            state_override: None,
            build_args: Box::new(|_ctx| {
                let recipient = hex::encode(pending_withdrawal_recipient(0));
                vec![recipient, "500000".into()]
            }),
        },
        CircuitDef {
            name: "claimL1FeesUnshielded",
            state_override: None,
            build_args: Box::new(|_ctx| {
                let recipient = "ab".repeat(32);
                vec!["500000".into(), recipient]
            }),
        },
        CircuitDef {
            name: "commitBatch",
            state_override: Some(Box::new(|mut cfg| {
                // commitBatch asserts lastCommittedBatchIndex == lastFinalizedBatchIndex;
                // setting to None makes the builder use the finalized index for both.
                cfg.last_committed_batch_index = None;
                cfg
            })),
            build_args: Box::new(|_ctx| {
                // parentBatchHash must match lastFinalizedBatchHash in the state
                let parent_hash = hex::encode(FINALIZE_PREV_BATCH_HASH);
                let new_hash = "cc".repeat(32);
                vec![parent_hash, new_hash]
            }),
        },
        CircuitDef {
            name: "setVerifierSet",
            state_override: None,
            build_args: Box::new(|_ctx| {
                vec!["[{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]".into()]
            }),
        },
        CircuitDef {
            name: "relayWithdrawNIGHTWithProof",
            state_override: None,
            build_args: Box::new(|ctx| {
                let data = ctx.relay_proof.as_ref()
                    .expect("relay_proof data must be pre-computed");
                let siblings_json: Vec<String> = data.proof_siblings.iter()
                    .map(|s| format!("\"{}\"", hex::encode(s)))
                    .collect();
                let index_bits_json: Vec<String> = data.index_bits.iter()
                    .map(|b| if *b { "true".into() } else { "false".into() })
                    .collect();
                let proof_json = format!(
                    "{{ batchIndex: {}, nonce: {}, indexBits: [{}], siblings: [{}] }}",
                    data.batch_index,
                    data.nonce,
                    index_bits_json.join(", "),
                    siblings_json.join(", "),
                );
                vec![
                    hex::encode(data.l2_sender),
                    hex::encode(data.l1_recipient),
                    data.amount.to_string(),
                    proof_json,
                ]
            }),
        },
        CircuitDef {
            name: "finalizeBatch",
            state_override: None,
            build_args: Box::new(|ctx| {
                let data = ctx.finalize_batch.as_ref()
                    .expect("finalize_batch data must be pre-computed");
                let bpd = &data.bpd;
                let bpd_json = format!(
                    "{{ version: {}, layer2ChainId: {}, rollupId: \"{}\", \
                    batchIndex: {}, daStartHeight: {}, daEndHeight: {}, \
                    daCommitment: \"{}\", lastProcessedQueueIndex: {}, \
                    messageQueueHash: \"{}\", prevStateRoot: \"{}\", \
                    prevBatchHash: \"{}\", postStateRoot: \"{}\", \
                    batchHash: \"{}\", withdrawRoot: \"{}\" }}",
                    bpd.version, bpd.layer2_chain_id, hex::encode(bpd.rollup_id),
                    bpd.batch_index, bpd.da_start_height, bpd.da_end_height,
                    hex::encode(bpd.da_commitment), bpd.last_processed_queue_index,
                    hex::encode(bpd.message_queue_hash), hex::encode(bpd.prev_state_root),
                    hex::encode(bpd.prev_batch_hash), hex::encode(bpd.post_state_root),
                    hex::encode(bpd.batch_hash), hex::encode(bpd.withdraw_root),
                );
                vec![
                    bpd_json,
                    data.signatures_json.clone(),
                    data.signer_bitmap.to_string(),
                    "0".into(),
                ]
            }),
        },
    ]
}

fn default_circuits() -> Vec<&'static str> {
    ALL_CIRCUIT_NAMES.to_vec()
}

fn find_circuit<'a>(name: &str, registry: &'a [CircuitDef]) -> Option<&'a CircuitDef> {
    registry.iter().find(|c| c.name == name)
}

// ---------------------------------------------------------------------------
// Pre-compute crypto data for hard circuits
// ---------------------------------------------------------------------------

const RELAY_L2_SENDER: [u8; 32] = [0x01; 32];
const RELAY_L1_RECIPIENT: [u8; 32] = [0x02; 32];
const RELAY_AMOUNT: u128 = 500_000;
const RELAY_NONCE: u64 = 0;
const RELAY_BATCH_INDEX: u64 = 42;

fn build_relay_proof_data() -> RelayProofData {
    let message_hash = hash_l2_to_l1_withdraw(
        RELAY_L2_SENDER, RELAY_L1_RECIPIENT, RELAY_AMOUNT, RELAY_NONCE,
    );
    let leaf_hash = compute_withdraw_leaf(message_hash);
    let leaf_index = RELAY_NONCE as usize;
    let mut leaves = vec![[0u8; 32]; leaf_index + 1];
    leaves[leaf_index] = leaf_hash;
    let withdraw_root = compute_merkle_root(&leaves, WITHDRAW_TREE_DEPTH)
        .expect("compute_merkle_root for relay proof");
    let proof_siblings = generate_merkle_proof(&leaves, leaf_index, WITHDRAW_TREE_DEPTH)
        .expect("generate_merkle_proof for relay proof");
    let index_bits = compute_index_bits(RELAY_NONCE, WITHDRAW_TREE_DEPTH);

    RelayProofData {
        l2_sender: RELAY_L2_SENDER,
        l1_recipient: RELAY_L1_RECIPIENT,
        amount: RELAY_AMOUNT,
        nonce: RELAY_NONCE,
        batch_index: RELAY_BATCH_INDEX,
        withdraw_root,
        proof_siblings,
        index_bits,
    }
}

const FINALIZE_BATCH_HASH: [u8; 32] = [0xCC; 32];
const FINALIZE_PREV_BATCH_HASH: [u8; 32] = [0xBB; 32];

fn build_finalize_batch_data() -> FinalizeBatchData {
    let bpd = BatchPublicDataV1Full {
        version: 1,
        layer2_chain_id: 0,
        rollup_id: [0u8; 32],
        batch_index: 1,
        da_start_height: 0,
        da_end_height: 0,
        da_commitment: [0u8; 32],
        last_processed_queue_index: 0,
        message_queue_hash: [0u8; 32],
        prev_state_root: [0u8; 32],
        prev_batch_hash: FINALIZE_PREV_BATCH_HASH,
        post_state_root: [0x01; 32],
        batch_hash: FINALIZE_BATCH_HASH,
        withdraw_root: [0u8; 32],
    };

    let keys: Vec<BigUint> = DEFAULT_VERIFIER_SECRET_KEYS
        .iter()
        .map(|&u| BigUint::from(u))
        .collect();
    let (sigs_json_raw, _) = build_signatures_json(&bpd, "1", &keys)
        .expect("build_signatures_json for finalize_batch");

    let sigs_arr: Vec<serde_json::Value> = serde_json::from_str(&sigs_json_raw)
        .expect("parse signatures JSON array");
    let sigs_json5_items: Vec<String> = sigs_arr.iter().map(|sig| {
        let pk = sig.get("pk").unwrap();
        let r = sig.get("r").unwrap();
        let s = sig.get("s").unwrap().as_str().unwrap();
        format!(
            "{{ pk: {{ x: \"{}\", y: \"{}\" }}, r: {{ x: \"{}\", y: \"{}\" }}, s: \"{}\" }}",
            pk.get("x").unwrap().as_str().unwrap(),
            pk.get("y").unwrap().as_str().unwrap(),
            r.get("x").unwrap().as_str().unwrap(),
            r.get("y").unwrap().as_str().unwrap(),
            s,
        )
    }).collect();
    let signatures_json5 = format!("[{}]", sigs_json5_items.join(", "));

    let signer_bitmap = (1u8 << DEFAULT_VERIFIER_SECRET_KEYS.len()) - 1;

    FinalizeBatchData {
        bpd,
        signatures_json: signatures_json5,
        signer_bitmap,
    }
}

/// Build a unified BridgeStateConfig that satisfies all circuits including hard ones.
fn build_unified_state_config(
    coin_public_bytes: &[u8; 32],
    num_entries: u64,
    relay_proof: &RelayProofData,
) -> BridgeStateConfig {
    let keys: Vec<BigUint> = DEFAULT_VERIFIER_SECRET_KEYS
        .iter()
        .map(|&u| BigUint::from(u))
        .collect();
    let verifier_set = derive_verifier_public_keys(&keys);

    BridgeStateConfig {
        num_deposits: num_entries,
        num_sequencers: num_entries,
        num_finalizers: num_entries,
        num_withdraw_roots: num_entries,
        num_message_hashes: num_entries,
        num_executed_messages: num_entries,
        num_pending_withdrawals: std::cmp::max(num_entries, 1),
        owner: *coin_public_bytes,
        locked_night: 10u128.pow(18),
        fee_vault: 10u128.pow(18),
        last_finalized_batch_hash: FINALIZE_PREV_BATCH_HASH,
        l2_gateway_balances: vec![(*coin_public_bytes, 10u128.pow(18))],
        verifier_set,
        signature_threshold: 2,
        last_committed_batch_hash: FINALIZE_BATCH_HASH,
        last_committed_batch_index: Some(1),
        specific_withdraw_roots: vec![(relay_proof.batch_index, relay_proof.withdraw_root)],
        last_finalized_state_root: [0u8; 32],
        extra_sequencers: vec![*coin_public_bytes],
        extra_finalizers: vec![*coin_public_bytes],
    }
}

// ---------------------------------------------------------------------------
// Multi-circuit automated test
// ---------------------------------------------------------------------------

/// Fully automated end-to-end time-to-dismiss diagnostic for multiple Bridge circuits.
///
/// Pipeline (per circuit):
///   1. Build Bridge ContractState with configurable field populations
///   2. Serialize state to temp file
///   3. Generate intent via `midnight-node-toolkit generate-intent circuit`
///   4. Deserialize the intent, wrap in a minimal Transaction
///   5. Cost-check the transaction, report diagnostics
///
/// Gated by `RUN_AUTOMATED_TTD_TEST=1`.
///
/// Key env vars:
///   - TOOLKIT_BIN: path to midnight-node-toolkit (default: on PATH)
///   - NUM_ENTRIES: entries per collection field (default: 500)
///   - CIRCUITS: comma-separated circuit names (default: all feasible)
///   - EXPECT_TTD_FAILURE: "1" to assert OutsideTimeToDismiss
///   - MIN_TIME_TO_DISMISS_PS / TIME_TO_DISMISS_PER_BYTE_PS: override limits
///   - COIN_PUBLIC: 64-char hex coin public key (default: 64 zeros)
#[test]
fn automated_deposit_unshielded_time_to_dismiss() {
    if std::env::var("RUN_AUTOMATED_TTD_TEST").ok().as_deref() != Some("1") {
        return;
    }

    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("could not determine repo root from CARGO_MANIFEST_DIR");

    let patch_script = repo_root.join("bridge-cli/scripts/patch-compact-runtime-charged-state.sh");
    if patch_script.exists() {
        let status = std::process::Command::new("bash")
            .arg(&patch_script)
            .status()
            .expect("failed to run module unification patch");
        assert!(status.success(), "module unification patch failed");
    }

    struct UnpatchGuard(PathBuf);
    impl Drop for UnpatchGuard {
        fn drop(&mut self) {
            let _ = std::process::Command::new("bash")
                .arg(&self.0)
                .arg("--unpatch")
                .status();
        }
    }
    let _unpatch = UnpatchGuard(patch_script);

    let midnight_node = std::env::var("MIDNIGHT_NODE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| repo_root.join("midnight-node"));

    let toolkit_bin = std::env::var("TOOLKIT_BIN")
        .unwrap_or_else(|_| "midnight-node-toolkit".to_string());
    let toolkit_js_path = std::env::var("TOOLKIT_JS_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| midnight_node.join("util/toolkit-js"));
    let bridge_artifacts = std::env::var("BRIDGE_ARTIFACTS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| repo_root.join("bridge-contract/dist/managed/Bridge"));
    let bridge_config = std::env::var("BRIDGE_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|_| repo_root.join("bridge-cli/toolkit-config/contract.config.ts"));
    let contract_address = std::env::var("CONTRACT_ADDRESS")
        .unwrap_or_else(|_| format!("{:0>64}", "1"));
    let coin_public = std::env::var("COIN_PUBLIC")
        .unwrap_or_else(|_| "0".repeat(64));
    let num_entries: u64 = std::env::var("NUM_ENTRIES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(500);
    let expect_failure = std::env::var("EXPECT_TTD_FAILURE").ok().as_deref() == Some("1");

    let registry = build_circuit_registry();

    let circuit_names: Vec<String> = match std::env::var("CIRCUITS") {
        Ok(val) => {
            val.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .map(|s| {
                    if find_circuit(&s, &registry).is_none() {
                        panic!("unknown circuit: '{}'. Available: {:?}", s, default_circuits());
                    }
                    s
                })
                .collect()
        }
        Err(_) => default_circuits().into_iter().map(|s| s.to_string()).collect(),
    };

    let coin_public_bytes: [u8; 32] = {
        let bytes = hex::decode(&coin_public).expect("COIN_PUBLIC must be valid hex");
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&bytes);
        arr
    };

    if !midnight_node.exists() {
        eprintln!(
            "midnight-node not found at {} (clone or symlink it, or set MIDNIGHT_NODE env var)",
            midnight_node.display()
        );
        return;
    }
    if !toolkit_js_path.exists() {
        eprintln!("TOOLKIT_JS_PATH does not exist: {}", toolkit_js_path.display());
        return;
    }
    if !bridge_artifacts.exists() {
        eprintln!(
            "BRIDGE_ARTIFACTS does not exist: {} (run `npm run compact && npm run build` in bridge-contract)",
            bridge_artifacts.display()
        );
        return;
    }
    if !bridge_config.exists() {
        eprintln!("BRIDGE_CONFIG does not exist: {}", bridge_config.display());
        return;
    }

    let work_dir = std::env::temp_dir().join("automated_ttd_test");
    std::fs::create_dir_all(&work_dir).expect("create work dir");

    // Pre-compute crypto data for hard circuits
    let relay_proof = build_relay_proof_data();
    let finalize_batch = build_finalize_batch_data();

    let base_config = build_unified_state_config(&coin_public_bytes, num_entries, &relay_proof);

    let state_file = work_dir.join("state.bin");
    let private_state_file = work_dir.join("private_state.json");
    std::fs::write(&private_state_file, r#"{"privateState":0}"#)
        .expect("write private_state.json");

    // Build and serialize the base state; track whether we need to rebuild
    eprintln!("Building Bridge state with {} entries per field...", num_entries);
    let state = build_bridge_state(&base_config);
    serialize_bridge_state_to_file(&state, &state_file)
        .expect("serialize_bridge_state_to_file should succeed");
    eprintln!("State written to {}", state_file.display());
    let mut using_base_state = true;

    let params = ledger_parameters_from_env();
    let zswap_overhead = zswap_size_overhead();
    let mut summary: Vec<(String, String, String, String)> = Vec::new();
    let mut any_failed = false;

    let arg_ctx = CircuitArgContext {
        coin_public: coin_public.clone(),
        relay_proof: Some(relay_proof),
        finalize_batch: Some(finalize_batch),
    };

    for circuit_name in &circuit_names {
        let circuit = find_circuit(circuit_name, &registry).unwrap();

        // Rebuild state if this circuit needs an override, or restore base if previous was overridden
        if let Some(ref override_fn) = circuit.state_override {
            let overridden = override_fn(base_config.clone());
            eprintln!("  (rebuilding state for {} with override)", circuit.name);
            let state = build_bridge_state(&overridden);
            serialize_bridge_state_to_file(&state, &state_file)
                .expect("serialize overridden state");
            using_base_state = false;
        } else if !using_base_state {
            eprintln!("  (restoring base state)");
            let state = build_bridge_state(&base_config);
            serialize_bridge_state_to_file(&state, &state_file)
                .expect("serialize base state");
            using_base_state = true;
        }

        let args = (circuit.build_args)(&arg_ctx);
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

        let intent_file = work_dir.join(format!("{}_intent.bin", circuit.name));
        let output_ps = work_dir.join(format!("{}_ps.json", circuit.name));
        let output_zswap = work_dir.join(format!("{}_zswap.json", circuit.name));

        eprintln!("\n--- Generating intent for {} ---", circuit.name);
        let gen_result = run_toolkit_generate_intent(
            &toolkit_bin,
            &bridge_config,
            &toolkit_js_path,
            &state_file,
            &private_state_file,
            &contract_address,
            &coin_public,
            "undeployed",
            &intent_file,
            &output_ps,
            &output_zswap,
            circuit.name,
            &arg_refs,
        );

        match gen_result {
            Err(e) => {
                eprintln!("SKIP {}: generate-intent failed: {}", circuit.name, e);
                summary.push((
                    circuit.name.to_string(),
                    "SKIP".into(),
                    "-".into(),
                    format!("generate-intent failed: {}", &e[..e.len().min(200)]),
                ));
                continue;
            }
            Ok(_) => {}
        }

        let tx = match transaction_from_intent_file(&intent_file, "undeployed") {
            Ok(tx) => tx,
            Err(e) => {
                eprintln!("SKIP {}: failed to build tx: {}", circuit.name, e);
                summary.push((
                    circuit.name.to_string(),
                    "SKIP".into(),
                    "-".into(),
                    format!("tx build failed: {}", e),
                ));
                continue;
            }
        };

        let label = format!("{} (num_entries={})", circuit.name, num_entries);
        let (cost_to_dismiss, allowed) =
            print_cost_diagnostics(&tx, &params, &label, zswap_overhead);

        if cost_to_dismiss > allowed {
            summary.push((
                circuit.name.to_string(),
                "EXCEEDS".into(),
                format!("{:?}", cost_to_dismiss),
                format!("allowed={:?}", allowed),
            ));
        } else {
            summary.push((
                circuit.name.to_string(),
                "OK".into(),
                format!("{:?}", cost_to_dismiss),
                format!("allowed={:?}", allowed),
            ));
            if expect_failure {
                eprintln!("FAIL: {} passed but EXPECT_TTD_FAILURE=1", circuit.name);
                any_failed = true;
            }
        }
    }

    // Print summary table
    eprintln!("\n{:=<80}", "");
    eprintln!("SUMMARY (num_entries={}, params: min_ttd={:?}, per_byte={:?})",
        num_entries, params.limits.min_time_to_dismiss, params.limits.time_to_dismiss_per_byte);
    eprintln!("{:-<80}", "");
    eprintln!("{:<35} {:>8} {:>14} {}", "Circuit", "Status", "Cost", "Details");
    eprintln!("{:-<80}", "");
    for (name, status, cost, details) in &summary {
        eprintln!("{:<35} {:>8} {:>14} {}", name, status, cost, details);
    }
    eprintln!("{:=<80}\n", "");

    let _ = std::fs::remove_dir_all(&work_dir);

    if any_failed {
        panic!("One or more circuits had unexpected cost check results (see summary above)");
    }
}

/// Stress scenario: run toolkit with many intent files (or one heavy intent), then
/// cost-check with default/realistic params and assert OutsideTimeToDismiss.
///
/// Runs only when RUN_STRESS_COST_TEST=1. Requires TOOLKIT_BIN, GENESIS_FILE,
/// BRIDGE_ARTIFACTS, and INTENT_FILES (comma-separated paths to intent files).
/// Use many intents so the resulting tx exceeds time-to-dismiss with default params.
#[test]
fn stress_many_intents_exceed_time_to_dismiss() {
    if std::env::var("RUN_STRESS_COST_TEST").ok().as_deref() != Some("1") {
        return;
    }
    let toolkit_bin = std::env::var("TOOLKIT_BIN")
        .unwrap_or_else(|_| "midnight-node-toolkit".to_string());
    let genesis_file = match std::env::var("GENESIS_FILE") {
        Ok(p) => p,
        Err(_) => {
            eprintln!("GENESIS_FILE not set, skipping stress cost test");
            return;
        }
    };
    let intent_files_var = match std::env::var("INTENT_FILES") {
        Ok(p) => p,
        Err(_) => {
            eprintln!("INTENT_FILES not set (comma-separated), skipping stress cost test");
            return;
        }
    };
    let bridge_artifacts = match std::env::var("BRIDGE_ARTIFACTS") {
        Ok(p) => p,
        Err(_) => {
            eprintln!("BRIDGE_ARTIFACTS not set, skipping stress cost test");
            return;
        }
    };
    let intent_paths: Vec<std::path::PathBuf> = intent_files_var
        .split(',')
        .map(|s| s.trim().into())
        .filter(|p: &std::path::PathBuf| !p.as_os_str().is_empty())
        .collect();
    if intent_paths.is_empty() {
        eprintln!("INTENT_FILES empty, skipping stress cost test");
        return;
    }
    let genesis_path = Path::new(&genesis_file);
    if !genesis_path.exists() {
        eprintln!("GENESIS_FILE path does not exist: {}", genesis_file);
        return;
    }
    for p in &intent_paths {
        if !p.exists() {
            eprintln!("INTENT_FILES path does not exist: {}", p.display());
            return;
        }
    }
    let out_dir = std::env::temp_dir();
    let dest_file = out_dir.join("time_to_dismiss_stress_tx.mn");
    run_toolkit_send_intent(
        &toolkit_bin,
        genesis_path,
        &dest_file,
        &intent_paths,
        &[Path::new(&bridge_artifacts)],
    )
    .expect("toolkit send-intent should succeed");
    let bytes =
        std::fs::read(&dest_file).expect("failed to read tx file");
    let tx: Transaction<(), (), Pedersen, DefaultDB> =
        tagged_deserialize(bytes.as_slice()).expect("deserialize tx");
    let params = INITIAL_PARAMETERS;
    let result = tx.cost(&params, true);
    assert!(
        result.is_err(),
        "stress scenario: expected tx to exceed time-to-dismiss with default params"
    );
    let err = result.unwrap_err();
    assert!(
        matches!(err, FeeCalculationError::OutsideTimeToDismiss { .. }),
        "expected OutsideTimeToDismiss, got {:?}",
        err
    );
}
