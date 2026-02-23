use anyhow::{Result, anyhow};
use sha2::{Digest, Sha256};
use std::time::Duration;

use crate::bridge::abi::BatchPublicDataV1Full;
use crate::bridge::batch;
use crate::bridge::ledger::BridgeLedger;
use crate::cli::TestWithdrawArgs;
use crate::commands::decode::load_bridge_ledger;
use crate::ts_cli;

const WITHDRAW_TREE_DEPTH: usize = 16;
const ZERO_BYTES_32: [u8; 32] = [0u8; 32];

fn parse_hex32(value: &str, label: &str) -> Result<[u8; 32]> {
    let normalized = value.strip_prefix("0x").unwrap_or(value);
    if normalized.len() != 64 || !normalized.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(anyhow!("{label} must be 32-byte hex (64 chars)"));
    }
    let bytes = hex::decode(normalized).map_err(|e| anyhow!("{label} invalid hex: {e}"))?;
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn pad_ascii_32(text: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    let src = text.as_bytes();
    let len = src.len().min(32);
    out[..len].copy_from_slice(&src[..len]);
    out
}

fn strict_pad_32(text: &str) -> [u8; 32] {
    pad_ascii_32(text)
}

fn u_to_bytes32_le_u64(value: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..8].copy_from_slice(&value.to_le_bytes());
    out
}

fn u_to_bytes32_le_u128(value: u128) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..16].copy_from_slice(&value.to_le_bytes());
    out
}

fn sha256(data: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest(data);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

fn hash_l2_to_l1_withdraw(
    sender: [u8; 32],
    recipient: [u8; 32],
    amount: u128,
    nonce: u64,
) -> [u8; 32] {
    let ds = strict_pad_32("mdn:l2l1:wdraw");
    let mut preimage = Vec::with_capacity(32 * 5);
    preimage.extend_from_slice(&ds);
    preimage.extend_from_slice(&sender);
    preimage.extend_from_slice(&recipient);
    preimage.extend_from_slice(&u_to_bytes32_le_u128(amount));
    preimage.extend_from_slice(&u_to_bytes32_le_u64(nonce));
    sha256(&preimage)
}

fn compute_withdraw_leaf(message_hash: [u8; 32]) -> [u8; 32] {
    let ds = strict_pad_32("mdn:l2w:leaf");
    let mut preimage = Vec::with_capacity(64);
    preimage.extend_from_slice(&ds);
    preimage.extend_from_slice(&message_hash);
    sha256(&preimage)
}

fn compute_merkle_node_hash(left: [u8; 32], right: [u8; 32]) -> [u8; 32] {
    let mut preimage = Vec::with_capacity(64);
    preimage.extend_from_slice(&left);
    preimage.extend_from_slice(&right);
    sha256(&preimage)
}

fn compute_merkle_root(leaves: &[[u8; 32]], tree_depth: usize) -> Result<[u8; 32]> {
    let num_leaves = 1usize << tree_depth;
    if leaves.len() > num_leaves {
        return Err(anyhow!(
            "too many leaves: got {}, max {} for depth={}",
            leaves.len(),
            num_leaves,
            tree_depth
        ));
    }
    let mut current_level = vec![ZERO_BYTES_32; num_leaves];
    current_level[..leaves.len()].copy_from_slice(leaves);

    let mut level_size = num_leaves;
    while level_size > 1 {
        let next_size = level_size / 2;
        for i in 0..next_size {
            current_level[i] = compute_merkle_node_hash(current_level[2 * i], current_level[2 * i + 1]);
        }
        level_size = next_size;
    }
    Ok(current_level[0])
}

fn generate_merkle_proof(
    leaves: &[[u8; 32]],
    leaf_index: usize,
    tree_depth: usize,
) -> Result<Vec<[u8; 32]>> {
    let num_leaves = 1usize << tree_depth;
    if leaf_index >= num_leaves {
        return Err(anyhow!(
            "leaf index {} out of range [0, {})",
            leaf_index,
            num_leaves
        ));
    }
    if leaves.len() > num_leaves {
        return Err(anyhow!(
            "too many leaves: got {}, max {} for depth={}",
            leaves.len(),
            num_leaves,
            tree_depth
        ));
    }

    let mut current_level = vec![ZERO_BYTES_32; num_leaves];
    current_level[..leaves.len()].copy_from_slice(leaves);

    let mut proof = Vec::with_capacity(tree_depth);
    let mut current_index = leaf_index;
    for _level in 0..tree_depth {
        let sibling_index = current_index ^ 1;
        proof.push(current_level[sibling_index]);

        let next_size = current_level.len() / 2;
        let mut next_level = vec![ZERO_BYTES_32; next_size];
        for i in 0..next_size {
            next_level[i] = compute_merkle_node_hash(current_level[2 * i], current_level[2 * i + 1]);
        }
        current_level = next_level;
        current_index /= 2;
    }
    Ok(proof)
}

fn compute_index_bits(index: u64, depth: usize) -> Vec<bool> {
    let mut bits = Vec::with_capacity(depth);
    for i in 0..depth {
        bits.push((index & (1u64 << i)) != 0);
    }
    bits
}

async fn wait_for_ledger<F>(
    args: &crate::BridgeCallArgs,
    attempts: u32,
    delay_ms: u64,
    label: &str,
    predicate: F,
) -> Result<BridgeLedger>
where
    F: Fn(&BridgeLedger) -> bool,
{
    for _ in 0..attempts {
        let ledger = load_bridge_ledger(args).await?;
        if predicate(&ledger) {
            return Ok(ledger);
        }
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
    }
    Err(anyhow!("timed out waiting for {label}"))
}

fn log_progress(message: &str) {
    eprintln!("[decoder-rs test-withdraw] {message}");
}

pub async fn run(args: TestWithdrawArgs) -> Result<()> {
    ts_cli::validate_contract_address(&args.bridge.contract)?;
    let env_args = ts_cli::TsCliEnvVars::from_bridge_call(&args.bridge);

    let gas_limit: u64 = match &args.gas_limit {
        Some(v) => v.parse().map_err(|_| anyhow!("--gas-limit must be an integer"))?,
        None => 120_000,
    };
    let timestamp: u64 = match &args.timestamp {
        Some(v) => v.parse().map_err(|_| anyhow!("--timestamp must be an integer"))?,
        None => 0,
    };
    let signer_bitmap: u8 = args.signer_bitmap.unwrap_or_else(batch::default_signer_bitmap);
    let finalize_timestamp: u64 = args.finalize_timestamp.unwrap_or(0);

    let initial_ledger = load_bridge_ledger(&args.bridge).await?;
    let locked_before = initial_ledger.rollup.locked_night;

    let mut deposit_amount: u128 = if let Some(v) = &args.deposit_amount {
        v.parse()
            .map_err(|_| anyhow!("--deposit-amount must be a non-negative integer"))?
    } else {
        4
    };
    if deposit_amount < 4 {
        deposit_amount = 4;
    }

    let withdraw_amount: u128 = if let Some(v) = &args.withdraw_amount {
        v.parse()
            .map_err(|_| anyhow!("--withdraw-amount must be a non-negative integer"))?
    } else {
        deposit_amount / 2
    };
    if withdraw_amount == 0 {
        return Err(anyhow!("withdraw amount must be greater than zero"));
    }

    let claim_amount: u128 = if let Some(v) = &args.claim_amount {
        v.parse()
            .map_err(|_| anyhow!("--claim-amount must be a non-negative integer"))?
    } else if withdraw_amount > 1 {
        withdraw_amount - 1
    } else {
        withdraw_amount
    };
    if claim_amount == 0 || claim_amount > withdraw_amount {
        return Err(anyhow!(
            "claim amount must be positive and not exceed withdraw amount"
        ));
    }
    let expected_remainder = withdraw_amount - claim_amount;

    let recipient_address = match &args.recipient {
        Some(v) => parse_hex32(v, "--recipient")?,
        None => pad_ascii_32("decoder-rs-test-user"),
    };
    let l2_sender = match &args.l2_sender {
        Some(v) => parse_hex32(v, "--l2-sender")?,
        None => ZERO_BYTES_32,
    };

    if !args.skip_set_verifier_set {
        log_progress("sending setVerifierSet...");
        ts_cli::run_set_verifier_set(&env_args)?;
    }

    log_progress("sending depositNIGHTUnshielded...");
    ts_cli::run_deposit(
        &env_args,
        &deposit_amount.to_string(),
        args.l2_recipient.as_deref(),
        Some(&gas_limit.to_string()),
        Some(&timestamp.to_string()),
    )?;

    log_progress("waiting for locked_night update...");
    let post_deposit_ledger = wait_for_ledger(
        &args.bridge,
        args.wait_attempts,
        args.wait_delay_ms,
        "locked_night after deposit",
        |ledger| ledger.rollup.locked_night >= locked_before.saturating_add(deposit_amount),
    )
    .await?;

    let withdraw_nonce = u64::try_from(post_deposit_ledger.rollup.executed_l2_to_l1_messages.len())
        .map_err(|_| anyhow!("withdraw nonce does not fit in u64"))?;
    if withdraw_nonce >= (1u64 << WITHDRAW_TREE_DEPTH) {
        return Err(anyhow!("withdraw nonce exceeds tree depth capacity"));
    }

    let withdraw_message_hash =
        hash_l2_to_l1_withdraw(l2_sender, recipient_address, withdraw_amount, withdraw_nonce);
    let withdraw_leaf = compute_withdraw_leaf(withdraw_message_hash);
    let leaf_index = usize::try_from(withdraw_nonce).map_err(|_| anyhow!("withdraw nonce too large"))?;
    let mut leaves = vec![ZERO_BYTES_32; leaf_index + 1];
    leaves[leaf_index] = withdraw_leaf;
    let withdraw_root = compute_merkle_root(&leaves, WITHDRAW_TREE_DEPTH)?;
    let proof = generate_merkle_proof(&leaves, leaf_index, WITHDRAW_TREE_DEPTH)?;
    let index_bits = compute_index_bits(withdraw_nonce, WITHDRAW_TREE_DEPTH);

    let current_ledger = load_bridge_ledger(&args.bridge).await?;
    let target_batch_index = current_ledger.rollup.misc_data.last_finalized_batch_index + 1;
    let batch_hash = if current_ledger.rollup.misc_data.last_committed_batch_index >= target_batch_index {
        current_ledger
            .rollup
            .committed_batches
            .get(&target_batch_index)
            .copied()
            .ok_or_else(|| anyhow!("expected committed batch at index {}", target_batch_index))?
    } else {
        let parent_index = current_ledger.rollup.misc_data.last_committed_batch_index;
        let parent_hash = current_ledger
            .rollup
            .committed_batches
            .get(&parent_index)
            .copied()
            .ok_or_else(|| anyhow!("missing parent committed batch at index {}", parent_index))?;
        let new_batch_hash = batch::random_bytes32();
        log_progress("sending commitBatch...");
        ts_cli::run_commit_batch(
            &env_args,
            &hex::encode(parent_hash),
            &hex::encode(new_batch_hash),
        )?;
        wait_for_ledger(
            &args.bridge,
            args.wait_attempts,
            args.wait_delay_ms,
            "last_committed_batch_index update",
            |ledger| ledger.rollup.misc_data.last_committed_batch_index >= target_batch_index,
        )
        .await?;
        new_batch_hash
    };

    let ledger_for_batch = load_bridge_ledger(&args.bridge).await?;
    let mut batch_public_data: BatchPublicDataV1Full =
        batch::build_batch_public_data(&ledger_for_batch, batch_hash)?;
    batch_public_data.withdraw_root = withdraw_root;
    let batch_public_data_json = ts_cli::batch_public_data_to_json(&batch_public_data);
    let signatures_json = ts_cli::build_signatures_json_from_batch(
        &env_args,
        &batch_public_data_json,
        args.signature_max_nonce,
    )?;

    log_progress("sending finalizeBatch...");
    ts_cli::run_finalize_batch(
        &env_args,
        &batch_public_data_json,
        &signatures_json,
        signer_bitmap,
        finalize_timestamp,
    )?;

    log_progress("waiting for last_finalized_batch_index update...");
    wait_for_ledger(
        &args.bridge,
        args.wait_attempts,
        args.wait_delay_ms,
        "last_finalized_batch_index update",
        |ledger| ledger.rollup.misc_data.last_finalized_batch_index >= target_batch_index,
    )
    .await?;

    let siblings_hex: Vec<String> = proof.iter().map(hex::encode).collect();
    let siblings_json = serde_json::to_string(&siblings_hex)
        .map_err(|e| anyhow!("failed to serialize siblings json: {e}"))?;
    let index_bits_json = serde_json::to_string(&index_bits)
        .map_err(|e| anyhow!("failed to serialize index_bits json: {e}"))?;

    log_progress("sending relayWithdrawNIGHTWithProof...");
    ts_cli::run_relay_withdraw_night_with_proof(
        &env_args,
        &hex::encode(l2_sender),
        &hex::encode(recipient_address),
        &withdraw_amount.to_string(),
        &batch_public_data.batch_index.to_string(),
        &withdraw_nonce.to_string(),
        &index_bits_json,
        &siblings_json,
    )?;

    log_progress("waiting for pending withdrawal after relay...");
    wait_for_ledger(
        &args.bridge,
        args.wait_attempts,
        args.wait_delay_ms,
        "pending withdrawal after relay",
        |ledger| {
            ledger
                .rollup
                .pending_withdrawals
                .get(&recipient_address)
                .copied()
                .unwrap_or(0)
                >= withdraw_amount
        },
    )
    .await?;

    log_progress("sending claimL1WithdrawalUnshielded...");
    ts_cli::run_claim_l1_withdrawal_unshielded(
        &env_args,
        &hex::encode(recipient_address),
        &claim_amount.to_string(),
    )?;

    log_progress("waiting for pending withdrawal remainder...");
    let after_claim = wait_for_ledger(
        &args.bridge,
        args.wait_attempts,
        args.wait_delay_ms,
        "pending withdrawal after claim",
        |ledger| {
            ledger
                .rollup
                .pending_withdrawals
                .get(&recipient_address)
                .copied()
                .unwrap_or(0)
                == expected_remainder
        },
    )
    .await?;

    let final_pending = after_claim
        .rollup
        .pending_withdrawals
        .get(&recipient_address)
        .copied()
        .unwrap_or(0);
    println!(
        "test-withdraw completed: recipient={}, deposit={}, withdraw={}, claim={}, pending_after_claim={}",
        hex::encode(recipient_address),
        deposit_amount,
        withdraw_amount,
        claim_amount,
        final_pending
    );
    Ok(())
}
