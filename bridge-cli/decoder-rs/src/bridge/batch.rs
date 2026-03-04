use anyhow::{anyhow, Result};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};

use crate::bridge::abi::BatchPublicDataV1Full;
use crate::bridge::ledger::{BridgeLedger, RollupLedger};

const DEFAULT_VERIFIER_SECRET_KEYS: [u64; 3] = [101, 102, 103];
const BATCH_DOMAIN: &[u8; 32] =
    b"mdn:bpd:v1full\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0";

pub fn compute_last_processed_queue_index(ledger: &BridgeLedger) -> u64 {
    if ledger.rollup.next_cross_domain_message_index == 0 {
        return 0;
    }
    let candidate = ledger.rollup.next_cross_domain_message_index - 1;
    if ledger.rollup.next_unfinalized_queue_index == 0 {
        return candidate;
    }
    let minimum = ledger.rollup.next_unfinalized_queue_index - 1;
    candidate.max(minimum)
}

pub fn build_batch_public_data(ledger: &BridgeLedger, batch_hash: [u8; 32]) -> Result<BatchPublicDataV1Full> {
    let last_finalized_batch_index = ledger.rollup.misc_data.last_finalized_batch_index;
    let batch_index = last_finalized_batch_index + 1;
    let prev_batch_hash = ledger.rollup.last_finalized_batch_hash;
    let prev_state_root = ledger.rollup.last_finalized_state_root;
    let last_processed_queue_index = compute_last_processed_queue_index(ledger);
    let message_queue_hash = lookup_or_zero(
        &ledger.rollup.message_rolling_hashes,
        last_processed_queue_index,
    );

    Ok(BatchPublicDataV1Full {
        version: 1,
        layer2_chain_id: ledger.rollup.layer2_chain_id,
        rollup_id: ledger.rollup.rollup_id,
        batch_index,
        da_start_height: 0,
        da_end_height: 0,
        da_commitment: [0u8; 32],
        last_processed_queue_index,
        message_queue_hash,
        prev_state_root,
        prev_batch_hash,
        post_state_root: random_bytes32(),
        batch_hash,
        withdraw_root: random_bytes32(),
    })
}

pub fn hash_batch_public_data_v1_full(bpd: &BatchPublicDataV1Full) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(BATCH_DOMAIN);
    hasher.update(u64_to_bytes32_le(u64::from(bpd.version)));
    hasher.update(u64_to_bytes32_le(bpd.layer2_chain_id));
    hasher.update(bpd.rollup_id);
    hasher.update(u64_to_bytes32_le(bpd.batch_index));
    hasher.update(u64_to_bytes32_le(bpd.da_start_height));
    hasher.update(u64_to_bytes32_le(bpd.da_end_height));
    hasher.update(bpd.da_commitment);
    hasher.update(u64_to_bytes32_le(bpd.last_processed_queue_index));
    hasher.update(bpd.message_queue_hash);
    hasher.update(bpd.prev_state_root);
    hasher.update(bpd.prev_batch_hash);
    hasher.update(bpd.post_state_root);
    hasher.update(bpd.withdraw_root);
    let digest = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

pub fn default_signer_bitmap() -> u8 {
    (1u8 << DEFAULT_VERIFIER_SECRET_KEYS.len()) - 1
}

pub fn random_bytes32() -> [u8; 32] {
    let mut out = [0u8; 32];
    OsRng.fill_bytes(&mut out);
    out
}

pub fn lookup_or_zero(map: &std::collections::BTreeMap<u64, [u8; 32]>, key: u64) -> [u8; 32] {
    map.get(&key).copied().unwrap_or([0u8; 32])
}

fn u64_to_bytes32_le(value: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..8].copy_from_slice(&value.to_le_bytes());
    out
}

pub fn ensure_committed_batch(rollup: &RollupLedger, batch_index: u64) -> Result<[u8; 32]> {
    if batch_index == rollup.misc_data.last_committed_batch_index {
        Ok(rollup.last_committed_batch_hash)
    } else if batch_index == rollup.misc_data.last_finalized_batch_index {
        Ok(rollup.last_finalized_batch_hash)
    } else {
        Err(anyhow!("batch {} not committed", batch_index))
    }
}
