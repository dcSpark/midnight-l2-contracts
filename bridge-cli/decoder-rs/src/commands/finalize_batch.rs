use anyhow::{Result, anyhow};

use crate::bridge::batch;
use crate::cli::BatchArgs;
use crate::commands::decode::load_bridge_ledger;
use crate::commands::mock_batch::read_latest_mock_batch;
use crate::executor_client;
use crate::signatures;
use crate::ts_cli;

pub async fn run(args: BatchArgs) -> Result<()> {
    ts_cli::validate_contract_address(&args.bridge.contract)?;

    let batch_public_data = read_latest_mock_batch()?;

    let ledger = load_bridge_ledger(&args.bridge).await?;
    let expected_batch_index = ledger.rollup.misc_data.last_finalized_batch_index + 1;
    if batch_public_data.batch_index != expected_batch_index {
        return Err(anyhow!(
            "mock batch index {} does not match expected pending index {}",
            batch_public_data.batch_index,
            expected_batch_index
        ));
    }
    let committed_batch_hash = batch::ensure_committed_batch(&ledger.rollup, expected_batch_index)?;
    if batch_public_data.batch_hash != committed_batch_hash {
        return Err(anyhow!(
            "mock batch hash {} does not match committed hash {} at batch index {}",
            hex::encode(batch_public_data.batch_hash),
            hex::encode(committed_batch_hash),
            expected_batch_index
        ));
    }
    let signer_bitmap = batch::default_signer_bitmap();
    let finalize_timestamp = 0u64;
    let batch_public_data_json = ts_cli::batch_public_data_to_json(&batch_public_data);

    let signatures_json = if let Some(ref base) = args.bridge.executor_url {
        executor_client::build_signatures(base, &batch_public_data_json, args.signature_max_nonce).await?
    } else {
        signatures::build_signatures_json(&batch_public_data, args.signature_max_nonce)?
    };

    if let Some(ref base) = args.bridge.executor_url {
        return executor_client::finalize_batch(
            base,
            &batch_public_data_json,
            &signatures_json,
            signer_bitmap,
            finalize_timestamp,
        )
        .await;
    }
    let env_args = ts_cli::TsCliEnvVars::from_bridge_call(&args.bridge);
    ts_cli::run_finalize_batch(
        &env_args,
        &batch_public_data_json,
        &signatures_json,
        signer_bitmap,
        finalize_timestamp,
    )
}
