use anyhow::Result;

use crate::cli::DepositArgs;
use crate::executor_client;
use crate::ts_cli;

pub async fn run(args: DepositArgs) -> Result<()> {
    ts_cli::validate_contract_address(&args.bridge.contract)?;

    if let Some(ref base) = args.bridge.executor_url {
        let res = executor_client::deposit(
            base,
            &args.amount,
            args.l2_recipient.as_deref(),
            args.gas_limit.as_deref(),
            args.timestamp.as_deref(),
        )
        .await?;
        if !res.tx_hash.is_empty() {
            println!("deposit submitted: txHash {}", res.tx_hash);
        }
        return Ok(());
    }
    let env_args = ts_cli::TsCliEnvVars::from_bridge_call(&args.bridge);
    ts_cli::run_deposit(
        &env_args,
        &args.amount,
        args.l2_recipient.as_deref(),
        args.gas_limit.as_deref(),
        args.timestamp.as_deref(),
    )
}
