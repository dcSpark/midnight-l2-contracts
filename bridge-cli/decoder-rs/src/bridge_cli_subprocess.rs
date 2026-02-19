//! Invoke the TypeScript bridge-cli (commit-batch / finalize-batch) via subprocess.
//! Commit/finalize in pure Rust does not work; this delegates to the working TS implementation.

use anyhow::{Context, Result};
use std::process::Command;

use crate::bridge_abi::{BatchPublicDataV1Full, Signature, fr_to_decimal_string};
/// BatchArgs subset needed to build env for the subprocess.
pub struct BatchArgsEnv {
    pub contract: String,
    pub indexer: String,
    pub node_ws: String,
    pub proof_server: String,
    pub funding_seed: String,
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

fn run_bridge_cli_cmd(args: &[&str], env_args: &BatchArgsEnv) -> Result<std::process::ExitStatus> {
    let root = bridge_cli_root()?;
    let mut cmd = Command::new("npx");
    cmd.args(["--yes", "tsx", "src/cli.ts"])
        .args(args)
        .current_dir(&root)
        .env("BRIDGE_CONTRACT_ADDRESS", &env_args.contract)
        .env("INDEXER_HTTP", &env_args.indexer)
        .env("MIDNIGHT_NODE_WS", &env_args.node_ws)
        .env("PROOF_SERVER", &env_args.proof_server)
        .env("FUNDING_SEED", &env_args.funding_seed);
    let status = cmd
        .status()
        .context("failed to run bridge-cli (is Node/npx/tsx available?)")?;
    Ok(status)
}

/// Run `bridge-cli commit-batch` with the given args. Forwards stdout/stderr.
/// Both parent_hash and batch_hash are required by the TS CLI.
pub fn run_commit_batch(env_args: &BatchArgsEnv, parent_hash: &str, batch_hash: &str) -> Result<()> {
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

/// Serialize [Signature; 3] to JSON string expected by TS CLI (pk, r, s with x,y,s as decimal strings).
pub fn signatures_to_json(sigs: &[Signature; 3]) -> String {
    let arr: Vec<serde_json::Value> = sigs
        .iter()
        .map(|sig| {
            serde_json::json!({
                "pk": { "x": fr_to_decimal_string(&sig.pk.x), "y": fr_to_decimal_string(&sig.pk.y) },
                "r": { "x": fr_to_decimal_string(&sig.r.x), "y": fr_to_decimal_string(&sig.r.y) },
                "s": fr_to_decimal_string(&sig.s),
            })
        })
        .collect();
    serde_json::to_string(&arr).expect("signatures JSON")
}

/// Run `bridge-cli finalize-batch` with the four required arguments (two JSON, two decimal).
pub fn run_finalize_batch(
    env_args: &BatchArgsEnv,
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
