//! Invoke the TypeScript bridge-cli via subprocess.

use anyhow::{Context, Result};
use std::process::Command;

use crate::bridge::abi::BatchPublicDataV1Full;
use crate::cli::BridgeCallArgs;

/// Env vars passed to TypeScript bridge-cli subprocess calls.
pub struct TsCliEnvVars {
    pub contract: String,
    pub indexer: String,
    pub node_ws: String,
    pub proof_server: String,
    pub funding_seed: String,
    pub local_prover: bool,
    pub fetch_concurrency: usize,
    pub bridge_artifacts: String,
}

impl TsCliEnvVars {
    pub fn from_bridge_call(args: &BridgeCallArgs) -> Self {
        Self {
            contract: args.contract.clone(),
            indexer: args.indexer.clone(),
            node_ws: args.node_ws.clone(),
            proof_server: args.proof_server.clone(),
            funding_seed: args.funding_seed.clone(),
            local_prover: args.local_prover,
            fetch_concurrency: args.fetch_concurrency,
            bridge_artifacts: args.bridge_artifacts.clone(),
        }
    }
}

pub fn validate_contract_address(address: &str) -> Result<()> {
    if address.len() != 64 || !address.chars().all(|c| c.is_ascii_hexdigit()) {
        anyhow::bail!("contract address must be 64 lowercase hex chars");
    }
    Ok(())
}

/// Directory containing the bridge-cli package (where package.json and src/cli.ts live).
fn bridge_cli_root() -> Result<std::path::PathBuf> {
    if let Ok(dir) = std::env::var("BRIDGE_CLI_DIR") {
        let path = std::path::PathBuf::from(dir);
        if path.is_dir() {
            return Ok(path);
        }
    }
    let current = std::env::current_dir().context("current_dir")?;
    let parent = current.parent().context("decoder-rs must run from bridge-cli/decoder-rs")?;
    Ok(parent.to_path_buf())
}

fn run_bridge_cli_cmd(args: &[&str], env_args: &TsCliEnvVars) -> Result<std::process::ExitStatus> {
    let root = bridge_cli_root()?;
    let mut cmd = Command::new("npx");
    cmd.args(["--yes", "tsx", "src/cli.ts"])
        .args(args)
        .current_dir(&root)
        .env("BRIDGE_CONTRACT_ADDRESS", &env_args.contract)
        .env("INDEXER_HTTP", &env_args.indexer)
        .env("MIDNIGHT_NODE_WS", &env_args.node_ws)
        .env("PROOF_SERVER", &env_args.proof_server)
        .env("FUNDING_SEED", &env_args.funding_seed)
        .env("LOCAL_PROVER", if env_args.local_prover { "1" } else { "0" })
        .env("FETCH_CONCURRENCY", env_args.fetch_concurrency.to_string())
        .env("BRIDGE_ARTIFACTS", &env_args.bridge_artifacts);
    let status = cmd
        .status()
        .context("failed to run bridge-cli (is Node/npx/tsx available?)")?;
    Ok(status)
}

fn run_bridge_cli_cmd_output(
    args: &[&str],
    env_args: &TsCliEnvVars,
    extra_env: &[(&str, String)],
) -> Result<std::process::Output> {
    let root = bridge_cli_root()?;
    let mut cmd = Command::new("npx");
    cmd.args(["--yes", "tsx"])
        .args(args)
        .current_dir(&root)
        .env("BRIDGE_CONTRACT_ADDRESS", &env_args.contract)
        .env("INDEXER_HTTP", &env_args.indexer)
        .env("MIDNIGHT_NODE_WS", &env_args.node_ws)
        .env("PROOF_SERVER", &env_args.proof_server)
        .env("FUNDING_SEED", &env_args.funding_seed)
        .env("LOCAL_PROVER", if env_args.local_prover { "1" } else { "0" })
        .env("FETCH_CONCURRENCY", env_args.fetch_concurrency.to_string())
        .env("BRIDGE_ARTIFACTS", &env_args.bridge_artifacts);
    for (key, value) in extra_env {
        cmd.env(key, value);
    }
    let output = cmd
        .output()
        .context("failed to run bridge-cli helper script (is Node/npx/tsx available?)")?;
    Ok(output)
}

/// Run `bridge-cli commit-batch` with the given args. Forwards stdout/stderr.
/// Both parent_hash and batch_hash are required by the TS CLI.
pub fn run_commit_batch(env_args: &TsCliEnvVars, parent_hash: &str, batch_hash: &str) -> Result<()> {
    let args = [
        "commit-batch",
        "--contract",
        env_args.contract.as_str(),
        "--parent-hash",
        parent_hash,
        "--batch-hash",
        batch_hash,
    ];
    let status = run_bridge_cli_cmd(&args, env_args)?;
    if status.success() {
        Ok(())
    } else {
        anyhow::bail!("bridge-cli commit-batch exited with {}", status)
    }
}

/// Serialize BatchPublicDataV1Full to JSON string expected by TS CLI (camelCase, hex for bytes).
pub fn batch_public_data_to_json(bpd: &BatchPublicDataV1Full) -> String {
    serde_json::json!({
        "version": bpd.version.to_string(),
        "layer2ChainId": bpd.layer2_chain_id.to_string(),
        "rollupId": hex::encode(bpd.rollup_id),
        "batchIndex": bpd.batch_index.to_string(),
        "daStartHeight": bpd.da_start_height.to_string(),
        "daEndHeight": bpd.da_end_height.to_string(),
        "daCommitment": hex::encode(bpd.da_commitment),
        "lastProcessedQueueIndex": bpd.last_processed_queue_index.to_string(),
        "messageQueueHash": hex::encode(bpd.message_queue_hash),
        "prevStateRoot": hex::encode(bpd.prev_state_root),
        "prevBatchHash": hex::encode(bpd.prev_batch_hash),
        "postStateRoot": hex::encode(bpd.post_state_root),
        "batchHash": hex::encode(bpd.batch_hash),
        "withdrawRoot": hex::encode(bpd.withdraw_root),
    })
    .to_string()
}

/// Run `bridge-cli finalize-batch` with the four required arguments (two JSON, two decimal).
pub fn run_finalize_batch(
    env_args: &TsCliEnvVars,
    batch_public_data_json: &str,
    signatures_json: &str,
    signer_bitmap: u8,
    finalize_timestamp: u64,
) -> Result<()> {
    let args = [
        "finalize-batch",
        "--contract",
        env_args.contract.as_str(),
        "--batch-public-data",
        batch_public_data_json,
        "--signatures",
        signatures_json,
        "--signer-bitmap",
        &signer_bitmap.to_string(),
        "--finalize-timestamp",
        &finalize_timestamp.to_string(),
    ];
    let status = run_bridge_cli_cmd(&args, env_args)?;
    if status.success() {
        Ok(())
    } else {
        anyhow::bail!("bridge-cli finalize-batch exited with {}", status)
    }
}

/// Run `bridge-cli deposit` and forward arguments as-is.
pub fn run_deposit(
    env_args: &TsCliEnvVars,
    amount: &str,
    l2_recipient: Option<&str>,
    gas_limit: Option<&str>,
    timestamp: Option<&str>,
) -> Result<()> {
    let mut args = vec![
        "deposit",
        "--contract",
        env_args.contract.as_str(),
        "--amount",
        amount,
    ];
    if let Some(value) = l2_recipient {
        args.extend(["--l2-recipient", value]);
    }
    if let Some(value) = gas_limit {
        args.extend(["--gas-limit", value]);
    }
    if let Some(value) = timestamp {
        args.extend(["--timestamp", value]);
    }

    let status = run_bridge_cli_cmd(&args, env_args)?;
    if status.success() {
        Ok(())
    } else {
        anyhow::bail!("bridge-cli deposit exited with {}", status)
    }
}

/// Run `bridge-cli set-verifier-set`.
pub fn run_set_verifier_set(env_args: &TsCliEnvVars) -> Result<()> {
    let args = ["set-verifier-set", "--contract", env_args.contract.as_str()];
    let status = run_bridge_cli_cmd(&args, env_args)?;
    if status.success() {
        Ok(())
    } else {
        anyhow::bail!("bridge-cli set-verifier-set exited with {}", status)
    }
}

/// Run `bridge-cli relay-withdraw-night-with-proof`.
pub fn run_relay_withdraw_night_with_proof(
    env_args: &TsCliEnvVars,
    l2_sender: &str,
    recipient: &str,
    amount: &str,
    batch_index: &str,
    nonce: &str,
    index_bits_json: &str,
    siblings_json: &str,
) -> Result<()> {
    let args = [
        "relay-withdraw-night-with-proof",
        "--contract",
        env_args.contract.as_str(),
        "--l2-sender",
        l2_sender,
        "--recipient",
        recipient,
        "--amount",
        amount,
        "--batch-index",
        batch_index,
        "--nonce",
        nonce,
        "--index-bits",
        index_bits_json,
        "--siblings",
        siblings_json,
    ];
    let status = run_bridge_cli_cmd(&args, env_args)?;
    if status.success() {
        Ok(())
    } else {
        anyhow::bail!("bridge-cli relay-withdraw-night-with-proof exited with {}", status)
    }
}

/// Run `bridge-cli claim-l1-withdrawal-unshielded`.
pub fn run_claim_l1_withdrawal_unshielded(
    env_args: &TsCliEnvVars,
    recipient: &str,
    amount: &str,
) -> Result<()> {
    let args = [
        "claim-l1-withdrawal-unshielded",
        "--contract",
        env_args.contract.as_str(),
        "--recipient",
        recipient,
        "--amount",
        amount,
    ];
    let status = run_bridge_cli_cmd(&args, env_args)?;
    if status.success() {
        Ok(())
    } else {
        anyhow::bail!(
            "bridge-cli claim-l1-withdrawal-unshielded exited with {}",
            status
        )
    }
}

/// Build signatures JSON via TS batch-helpers to match contract/browser pure circuits exactly.
pub fn build_signatures_json_from_batch(
    env_args: &TsCliEnvVars,
    batch_public_data_json: &str,
    signature_max_nonce: u64,
) -> Result<String> {
    let ts_script = r#"
import {
  parseBatchPublicDataFromJson,
  hashBatchPublicDataV1Full,
  buildSignatureVector,
  signaturesToJson,
} from './src/batch-helpers.ts';

const raw = process.env.BATCH_PUBLIC_DATA_JSON ?? '';
if (!raw) {
  throw new Error('missing batch public data json arg');
}
const bpd = parseBatchPublicDataFromJson(raw);
const digest = hashBatchPublicDataV1Full(bpd);
const sigs = buildSignatureVector(digest);
process.stdout.write(signaturesToJson(sigs));
"#;
    let args = ["-e", ts_script];
    let output = run_bridge_cli_cmd_output(
        &args,
        env_args,
        &[
            ("SIGNATURE_MAX_NONCE", signature_max_nonce.to_string()),
            (
                "BATCH_PUBLIC_DATA_JSON",
                batch_public_data_json.to_string(),
            ),
        ],
    )?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!(
            "bridge-cli TS signature helper exited with {}: {}",
            output.status,
            stderr.trim()
        );
    }
    let stdout = String::from_utf8(output.stdout)
        .context("bridge-cli TS signature helper output was not valid UTF-8")?;
    Ok(stdout.trim().to_string())
}
