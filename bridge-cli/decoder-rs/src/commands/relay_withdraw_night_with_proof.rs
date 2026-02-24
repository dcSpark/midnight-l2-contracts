use anyhow::{Result, anyhow};

use crate::cli::RelayWithdrawArgs;
use crate::executor_client;
use crate::ts_cli;

fn validate_hex32(label: &str, value: &str) -> Result<()> {
    let normalized = value.strip_prefix("0x").unwrap_or(value);
    if normalized.len() != 64 || !normalized.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(anyhow!("{label} must be 32-byte hex (64 chars)"));
    }
    Ok(())
}

pub async fn run(args: RelayWithdrawArgs) -> Result<()> {
    ts_cli::validate_contract_address(&args.bridge.contract)?;
    validate_hex32("--l2-sender", &args.l2_sender)?;
    validate_hex32("--recipient", &args.recipient)?;

    let amount: u128 = args
        .amount
        .parse()
        .map_err(|_| anyhow!("--amount must be a non-negative integer"))?;
    if amount == 0 {
        return Err(anyhow!("--amount must be positive"));
    }
    let _batch_index: u64 = args
        .batch_index
        .parse()
        .map_err(|_| anyhow!("--batch-index must be a non-negative integer"))?;
    let _nonce: u64 = args
        .nonce
        .parse()
        .map_err(|_| anyhow!("--nonce must be a non-negative integer"))?;

    let bits: Vec<bool> = serde_json::from_str(&args.index_bits)
        .map_err(|e| anyhow!("--index-bits must be JSON bool array: {e}"))?;
    if bits.len() != 16 {
        return Err(anyhow!("--index-bits must have exactly 16 elements"));
    }
    let siblings: Vec<String> = serde_json::from_str(&args.siblings)
        .map_err(|e| anyhow!("--siblings must be JSON string array: {e}"))?;
    if siblings.len() != 16 {
        return Err(anyhow!("--siblings must have exactly 16 elements"));
    }
    for (idx, sibling) in siblings.iter().enumerate() {
        validate_hex32(&format!("--siblings[{idx}]"), sibling)?;
    }

    if let Some(ref base) = args.bridge.executor_url {
        return executor_client::relay_withdraw_night_with_proof(
            base,
            &args.l2_sender,
            &args.recipient,
            &args.amount,
            &args.batch_index,
            &args.nonce,
            &args.index_bits,
            &args.siblings,
        )
        .await;
    }
    let env_args = ts_cli::TsCliEnvVars::from_bridge_call(&args.bridge);
    ts_cli::run_relay_withdraw_night_with_proof(
        &env_args,
        &args.l2_sender,
        &args.recipient,
        &args.amount,
        &args.batch_index,
        &args.nonce,
        &args.index_bits,
        &args.siblings,
    )
}
