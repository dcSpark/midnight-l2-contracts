use anyhow::Result;

use crate::cli::BridgeCallArgs;
use crate::executor_client;
use crate::ts_cli;

pub async fn run(args: BridgeCallArgs) -> Result<()> {
    ts_cli::validate_contract_address(&args.contract)?;
    if let Some(ref base) = args.executor_url {
        return executor_client::set_verifier_set(base).await;
    }
    let env_args = ts_cli::TsCliEnvVars::from_bridge_call(&args);
    ts_cli::run_set_verifier_set(&env_args)
}
