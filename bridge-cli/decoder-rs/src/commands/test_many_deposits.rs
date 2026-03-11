//! test-many-deposits command: run repeated deposit until a contract (or node) error
//! or a maximum number of attempts is reached. Used to stress the L1→L2 deposit path.

use anyhow::Result;

use crate::cli::TestManyDepositsArgs;
use crate::executor_client;
use crate::ts_cli;

pub async fn run(args: TestManyDepositsArgs) -> Result<()> {
    ts_cli::validate_contract_address(&args.bridge.contract)?;

    let max = args.max_attempts;

    for attempt in 1..=max {
        println!("Attempt {}/{}: deposit...", attempt, max);

        if let Some(ref base) = args.bridge.executor_url {
            if let Err(e) = executor_client::deposit(
                base,
                &args.amount,
                args.l2_recipient.as_deref(),
                args.gas_limit.as_deref(),
                args.timestamp.as_deref(),
            )
            .await
            {
                eprintln!("Failed at attempt {} (deposit): {}", attempt, e);
                return Err(e.into());
            }
        } else {
            let env_args = ts_cli::TsCliEnvVars::from_bridge_call(&args.bridge);
            if let Err(e) = ts_cli::run_deposit(
                &env_args,
                &args.amount,
                args.l2_recipient.as_deref(),
                args.gas_limit.as_deref(),
                args.timestamp.as_deref(),
            ) {
                eprintln!("Failed at attempt {} (deposit): {}", attempt, e);
                return Err(e.into());
            }
        }

        println!("Attempt {}/{} OK.", attempt, max);
    }

    println!("Completed {} deposits (max {}).", max, max);
    Ok(())
}
