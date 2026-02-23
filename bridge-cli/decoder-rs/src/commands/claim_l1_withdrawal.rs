use anyhow::{Result, anyhow};

use crate::cli::ClaimL1WithdrawalArgs;
use crate::ts_cli;

fn validate_hex32(label: &str, value: &str) -> Result<()> {
    let normalized = value.strip_prefix("0x").unwrap_or(value);
    if normalized.len() != 64 || !normalized.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(anyhow!("{label} must be 32-byte hex (64 chars)"));
    }
    Ok(())
}

pub fn run(args: ClaimL1WithdrawalArgs) -> Result<()> {
    ts_cli::validate_contract_address(&args.bridge.contract)?;
    validate_hex32("--recipient", &args.recipient)?;
    let amount: u128 = args
        .amount
        .parse()
        .map_err(|_| anyhow!("--amount must be a non-negative integer"))?;
    if amount == 0 {
        return Err(anyhow!("--amount must be positive"));
    }

    let env_args = ts_cli::TsCliEnvVars::from_bridge_call(&args.bridge);
    ts_cli::run_claim_l1_withdrawal_unshielded(&env_args, &args.recipient, &args.amount)
}
