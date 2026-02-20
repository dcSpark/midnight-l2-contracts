use anyhow::Result;

use crate::cli::DepositArgs;
use crate::ts_cli;

pub fn run(args: DepositArgs) -> Result<()> {
    ts_cli::validate_contract_address(&args.bridge.contract)?;

    let env_args = ts_cli::TsCliEnvVars::from_bridge_call(&args.bridge);
    ts_cli::run_deposit(
        &env_args,
        &args.amount,
        args.l2_recipient.as_deref(),
        args.gas_limit.as_deref(),
        args.timestamp.as_deref(),
    )
}
