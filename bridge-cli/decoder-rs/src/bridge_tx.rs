use anyhow::{anyhow, Result};
use midnight_node_ledger_helpers::base_crypto::fab::AlignedValue;

use crate::bridge_abi::{encode_commit_batch, encode_finalize_batch};
use crate::bridge_batch::{
    build_batch_public_data, build_signature_vector, commit_batch_hash_override,
    default_signer_bitmap, ensure_committed_batch, hash_batch_public_data_v1_full,
    random_bytes32, snapshot_from_ledger,
};
use crate::{BatchArgs, BridgeLedger};

pub struct ContractCallPlan {
    pub input: AlignedValue,
}

pub async fn build_commit_batch_plan(args: &BatchArgs, ledger: &BridgeLedger) -> Result<ContractCallPlan> {
    let snapshot = snapshot_from_ledger(ledger);
    let parent_index = snapshot.last_committed_batch_index;
    let parent_batch_hash = ensure_committed_batch(&ledger.rollup, parent_index)?;
    let batch_hash = commit_batch_hash_override(args.batch_hash.as_deref())?.unwrap_or_else(random_bytes32);

    let input = encode_commit_batch(parent_batch_hash, batch_hash)?;
    Ok(ContractCallPlan { input })
}

pub async fn build_finalize_batch_plan(args: &BatchArgs, ledger: &BridgeLedger) -> Result<ContractCallPlan> {
    let snapshot = snapshot_from_ledger(ledger);
    let batch_index = snapshot.last_finalized_batch_index + 1;
    let batch_hash = ensure_committed_batch(&ledger.rollup, batch_index)?;
    let batch_public_data = build_batch_public_data(ledger, &snapshot, batch_hash)?;
    let digest = hash_batch_public_data_v1_full(&batch_public_data);
    let signatures = build_signature_vector(digest, Some(args.signature_max_nonce))?;
    let signer_bitmap = default_signer_bitmap();
    let finalize_timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|err| anyhow!("invalid system clock: {err}"))?
        .as_secs();

    let input = encode_finalize_batch(&batch_public_data, &signatures, signer_bitmap, finalize_timestamp)?;
    Ok(ContractCallPlan { input })
}
