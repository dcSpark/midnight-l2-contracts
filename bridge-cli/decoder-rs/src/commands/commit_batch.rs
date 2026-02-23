use anyhow::{Result, anyhow};

use crate::bridge::batch;
use crate::cli::BatchArgs;
use crate::commands::decode::load_bridge_ledger;
use crate::commands::mock_batch::write_latest_mock_batch;
use crate::ts_cli;

pub async fn run(args: BatchArgs) -> Result<()> {
    ts_cli::validate_contract_address(&args.bridge.contract)?;

    let ledger = load_bridge_ledger(&args.bridge).await?;
    let parent_index = ledger.rollup.misc_data.last_committed_batch_index;
    let parent_hash_bytes = ledger.rollup.committed_batches.get(&parent_index).ok_or_else(|| {
        anyhow!(
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

    let env_args = ts_cli::TsCliEnvVars::from_bridge_call(&args.bridge);
    ts_cli::run_commit_batch(&env_args, &parent_hash_str, &batch_hash_str)
}
