use anyhow::Result;
use midnight_node_ledger_helpers::base_crypto::fab::AlignedValue;

use crate::bridge_abi::encode_commit_batch;
use crate::bridge_batch::{
    build_batch_public_data, ensure_committed_batch, hash_batch_public_data_v1_full,
    snapshot_from_ledger,
};
use crate::{BatchArgs, BridgeLedger};

pub struct ContractCallPlan {
    pub input: AlignedValue,
}

pub async fn build_commit_batch_plan(_args: &BatchArgs, ledger: &BridgeLedger) -> Result<ContractCallPlan> {
    let snapshot = snapshot_from_ledger(ledger);
    let parent_index = snapshot.last_committed_batch_index;
    let parent_batch_hash = ensure_committed_batch(&ledger.rollup, parent_index)?;
    let batch_public_data = build_batch_public_data(ledger, &snapshot, [0u8; 32])?;
    let batch_hash = hash_batch_public_data_v1_full(&batch_public_data);

    let input = encode_commit_batch(parent_batch_hash, batch_hash)?;
    Ok(ContractCallPlan { input })
}
