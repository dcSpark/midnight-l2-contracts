//! test-cost command: set verifier set, then run repeated commit-batch / finalize-batch
//! until a contract (or node) error is hit or a maximum number of attempts is reached.
//! Used to experiment with contract cost (e.g. time_to_dismiss) as batches grow.

use anyhow::Result;

use crate::bridge::batch;
use crate::cli::TestCostArgs;
use crate::commands::decode::load_bridge_ledger;
use crate::commands::mock_batch::{read_latest_mock_batch, write_latest_mock_batch};
use crate::executor_client;
use crate::signatures;
use crate::ts_cli;

pub async fn run(args: TestCostArgs) -> Result<()> {
    ts_cli::validate_contract_address(&args.bridge.contract)?;

    println!("Setting verifier set...");
    if let Some(ref base) = args.bridge.executor_url {
        executor_client::set_verifier_set(base).await?;
    } else {
        let env_args = ts_cli::TsCliEnvVars::from_bridge_call(&args.bridge);
        ts_cli::run_set_verifier_set(&env_args)?;
    }
    println!("Verifier set done.");

    let env_args = ts_cli::TsCliEnvVars::from_bridge_call(&args.bridge);
    let max = args.max_attempts;

    for attempt in 1..=max {
        println!("Attempt {}/{}: commit-batch...", attempt, max);

        let ledger = load_bridge_ledger(&args.bridge).await?;
        let parent_index = ledger.rollup.misc_data.last_committed_batch_index;
        let parent_hash_bytes = ledger
            .rollup
            .committed_batches
            .get(&parent_index)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "no committed batch at index {} (cannot derive parent hash)",
                    parent_index
                )
            })?;
        let parent_hash_str = hex::encode(parent_hash_bytes);
        let mut batch_public_data = batch::build_batch_public_data(&ledger, [0u8; 32])?;
        let batch_hash = batch::hash_batch_public_data_v1_full(&batch_public_data);
        batch_public_data.batch_hash = batch_hash;
        write_latest_mock_batch(&batch_public_data)?;
        let batch_hash_str = hex::encode(batch_hash);

        if let Some(ref base) = args.bridge.executor_url {
            if let Err(e) =
                executor_client::commit_batch(base, &parent_hash_str, &batch_hash_str).await
            {
                eprintln!("Failed at attempt {} (commit-batch): {}", attempt, e);
                return Err(e.into());
            }
        } else {
            if let Err(e) =
                ts_cli::run_commit_batch(&env_args, &parent_hash_str, &batch_hash_str)
            {
                eprintln!("Failed at attempt {} (commit-batch): {}", attempt, e);
                return Err(e.into());
            }
        }

        println!("Attempt {}/{}: finalize-batch...", attempt, max);

        let batch_public_data = read_latest_mock_batch()?;
        let ledger = load_bridge_ledger(&args.bridge).await?;
        let expected_batch_index = ledger.rollup.misc_data.last_finalized_batch_index + 1;
        if batch_public_data.batch_index != expected_batch_index {
            anyhow::bail!(
                "mock batch index {} does not match expected pending index {}",
                batch_public_data.batch_index,
                expected_batch_index
            );
        }
        batch::ensure_committed_batch(&ledger.rollup, expected_batch_index)?;
        let batch_public_data_json = ts_cli::batch_public_data_to_json(&batch_public_data);
        let verifier_keys = signatures::verifier_secret_keys_from_env()?;
        let (signatures_json, _) = signatures::build_signatures_json(
            &batch_public_data,
            &args.signature_nonce,
            &verifier_keys,
        )?;
        let signer_bitmap = batch::default_signer_bitmap();
        let finalize_timestamp = 0u64;

        if let Some(ref base) = args.bridge.executor_url {
            if let Err(e) = executor_client::finalize_batch(
                base,
                &batch_public_data_json,
                &signatures_json,
                signer_bitmap,
                finalize_timestamp,
            )
            .await
            {
                eprintln!("Failed at attempt {} (finalize-batch): {}", attempt, e);
                return Err(e.into());
            }
        } else {
            if let Err(e) = ts_cli::run_finalize_batch(
                &env_args,
                &batch_public_data_json,
                &signatures_json,
                signer_bitmap,
                finalize_timestamp,
            ) {
                eprintln!("Failed at attempt {} (finalize-batch): {}", attempt, e);
                return Err(e.into());
            }
        }

        println!("Attempt {}/{} OK.", attempt, max);
    }

    println!("Completed {} commit+finalize cycles (max {}).", max, max);
    Ok(())
}
