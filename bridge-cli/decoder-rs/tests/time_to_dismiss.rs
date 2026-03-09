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

use decoder_rs::bridge::state_builder::{build_bridge_state, BridgeStateConfig, serialize_bridge_state_to_file};
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

/// Build LedgerParameters from env-var overrides or fall back to real-network defaults.
///
/// Supported env vars (values in picoseconds):
///   - `MIN_TIME_TO_DISMISS_PS`       (default: from INITIAL_PARAMETERS, ~15s)
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

/// Print cost diagnostics for a transaction without asserting pass/fail.
fn print_cost_diagnostics(tx: &TxType, params: &LedgerParameters, label: &str) {
    let cost_to_dismiss = tx.time_to_dismiss(&params.cost_model);

    let serialized_size = {
        let mut buf = Vec::new();
        tagged_serialize(tx, &mut buf).expect("serialize tx for size estimation");
        buf.len()
    };
    let allowed_time = CostDuration::max(
        params.limits.time_to_dismiss_per_byte * serialized_size as u64,
        params.limits.min_time_to_dismiss,
    );

    let full_cost = tx.cost(params, false).expect("cost(enforce=false) should succeed");

    eprintln!("\n=== Cost Diagnostics: {} ===", label);
    eprintln!("  Serialized tx size:       {} bytes", serialized_size);
    eprintln!("  cost_to_dismiss (actual):  {:?}", cost_to_dismiss);
    eprintln!("  allowed_time_to_dismiss:   {:?}", allowed_time);
    eprintln!("  min_time_to_dismiss param: {:?}", params.limits.min_time_to_dismiss);
    eprintln!("  per_byte param:            {:?}", params.limits.time_to_dismiss_per_byte);
    eprintln!("  synthetic_cost:            {:?}", full_cost);
    if cost_to_dismiss > allowed_time {
        eprintln!("  VERDICT: EXCEEDS time-to-dismiss limit");
    } else {
        eprintln!("  VERDICT: WITHIN time-to-dismiss limit");
    }
    eprintln!("==========================================\n");
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
    eprintln!("Running: {:?}", cmd);
    let output = cmd
        .output()
        .map_err(|e| format!("failed to run toolkit: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "toolkit send-intent exited with {}\nstdout: {}\nstderr: {}",
            output.status, stdout, stderr
        ));
    }
    if !dest_file.exists() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "toolkit did not produce dest file\nstdout: {}\nstderr: {}",
            stdout, stderr
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
    eprintln!("Running: {:?}", cmd);
    let output = cmd
        .output()
        .map_err(|e| format!("failed to run toolkit generate-intent: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "toolkit generate-intent exited with {}\nstdout: {}\nstderr: {}",
            output.status, stdout, stderr
        ));
    }
    if !output_intent.exists() {
        return Err("toolkit did not produce intent file".to_string());
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
/// is pre-populated with many entries (see docs/deposit-night-unshielded-time-to-dismiss-test.md).
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
    let config = BridgeStateConfig { num_deposits: num };
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
    let config = BridgeStateConfig { num_deposits: num };
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

/// Fully automated end-to-end time-to-dismiss diagnostic for depositNIGHTUnshielded.
///
/// Pipeline:
///   1. Build Bridge ContractState with N deposits in Rust
///   2. Serialize state to temp file
///   3. Generate intent via `midnight-node-toolkit generate-intent circuit`
///   4. Deserialize the intent, wrap in a minimal Transaction
///   5. Cost-check the transaction, report diagnostics, optionally assert failure
///
/// Gated by `RUN_AUTOMATED_TTD_TEST=1`.
///
/// The only env var you typically need to set is TOOLKIT_BIN (path to
/// midnight-node-toolkit binary). Everything else has sensible defaults
/// assuming `midnight-node` is present as a submodule at the repo root.
///
/// All env vars (with defaults derived from the repo layout):
///   - TOOLKIT_BIN: midnight-node-toolkit binary (default: "midnight-node-toolkit")
///   - MIDNIGHT_NODE: path to midnight-node checkout
///     (default: midnight-node/ relative to repo root)
///   - TOOLKIT_JS_PATH: toolkit-js directory
///     (default: $MIDNIGHT_NODE/util/toolkit-js)
///   - BRIDGE_ARTIFACTS: compiled Bridge artifact dir
///     (default: bridge-contract/dist/managed/Bridge relative to repo root)
///   - BRIDGE_CONFIG: contract.config.ts for toolkit-js
///     (default: bridge-cli/toolkit-config/contract.config.ts relative to repo root)
///   - CONTRACT_ADDRESS: 64 hex chars (default: dummy address -- the toolkit
///     does not validate it against the ledger for generate-intent)
///   - COIN_PUBLIC: coin public key, 64 hex chars (default: 64 zeros)
///   - NUM_DEPOSITS: number of l1ToL2Deposits entries to populate (default: 500)
///   - EXPECT_TTD_FAILURE: set to "1" to assert OutsideTimeToDismiss; otherwise
///     the test only reports diagnostics and passes regardless
///   - MIN_TIME_TO_DISMISS_PS: override min_time_to_dismiss in picoseconds
///   - TIME_TO_DISMISS_PER_BYTE_PS: override time_to_dismiss_per_byte in picoseconds
#[test]
fn automated_deposit_unshielded_time_to_dismiss() {
    if std::env::var("RUN_AUTOMATED_TTD_TEST").ok().as_deref() != Some("1") {
        return;
    }

    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("could not determine repo root from CARGO_MANIFEST_DIR");

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
    let num_deposits: u64 = std::env::var("NUM_DEPOSITS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(500);
    let expect_failure = std::env::var("EXPECT_TTD_FAILURE").ok().as_deref() == Some("1");

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

    // 1. Build state with N deposits
    eprintln!("Building Bridge state with {} deposits...", num_deposits);
    let config = BridgeStateConfig { num_deposits };
    let state = build_bridge_state(&config);

    // 2. Serialize state to file
    let state_file = work_dir.join("state.bin");
    serialize_bridge_state_to_file(&state, &state_file)
        .expect("serialize_bridge_state_to_file should succeed");
    eprintln!("State written to {}", state_file.display());

    // 3. Write private state JSON
    let private_state_file = work_dir.join("private_state.json");
    std::fs::write(&private_state_file, r#"{"privateState":0}"#)
        .expect("write private_state.json");

    // 4. Generate intent
    let intent_file = work_dir.join("intent.bin");
    let output_ps = work_dir.join("output_ps.json");
    let output_zswap = work_dir.join("output_zswap.json");

    let l2_recipient = "ab".repeat(32);
    let call_args: Vec<&str> = vec![
        "1000000",
        &l2_recipient,
        "100000",
        "0",
    ];

    eprintln!("Generating depositNIGHTUnshielded intent...");
    run_toolkit_generate_intent(
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
        "depositNIGHTUnshielded",
        &call_args,
    )
    .expect("toolkit generate-intent should succeed");
    eprintln!("Intent written to {}", intent_file.display());

    // 5. Build Transaction from intent and cost-check it
    eprintln!("Building Transaction from intent and running cost check...");
    let tx = transaction_from_intent_file(&intent_file, "undeployed")
        .expect("should build Transaction from intent");

    let params = ledger_parameters_from_env();
    let label = format!("depositNIGHTUnshielded (num_deposits={})", num_deposits);
    print_cost_diagnostics(&tx, &params, &label);

    let result = tx.cost(&params, true);
    match result {
        Err(FeeCalculationError::OutsideTimeToDismiss {
            time_to_dismiss,
            allowed_time_to_dismiss,
            size,
        }) => {
            eprintln!(
                "OutsideTimeToDismiss raised: cost={:?}, allowed={:?}, size={} bytes",
                time_to_dismiss, allowed_time_to_dismiss, size
            );
            if !expect_failure {
                eprintln!(
                    "NOTE: Set EXPECT_TTD_FAILURE=1 to turn this into a hard assertion. \
                     Currently in diagnostic mode -- test passes."
                );
            }
        }
        Ok(cost) => {
            eprintln!("Transaction cost check PASSED: {:?}", cost);
            if expect_failure {
                panic!(
                    "EXPECT_TTD_FAILURE=1 but cost check passed (Ok). \
                     The transaction fits within time-to-dismiss limits. \
                     Try increasing NUM_DEPOSITS or tightening limits via \
                     MIN_TIME_TO_DISMISS_PS / TIME_TO_DISMISS_PER_BYTE_PS."
                );
            }
        }
        Err(e) => {
            panic!("unexpected cost error (not OutsideTimeToDismiss): {:?}", e);
        }
    }

    let _ = std::fs::remove_dir_all(&work_dir);
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
