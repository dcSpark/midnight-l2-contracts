use anyhow::Result;

use crate::cli::BridgeCallArgs;
use crate::ts_cli;

pub fn run(args: BridgeCallArgs) -> Result<()> {
    ts_cli::validate_contract_address(&args.contract)?;
    let env_args = ts_cli::TsCliEnvVars::from_bridge_call(&args);
    ts_cli::run_set_verifier_set(&env_args)
}
