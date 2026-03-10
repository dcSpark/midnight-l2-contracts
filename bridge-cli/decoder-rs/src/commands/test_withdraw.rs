use anyhow::{Result, anyhow};
use std::time::Duration;

use crate::bridge::abi::BatchPublicDataV1Full;
use crate::bridge::batch;
use crate::bridge::ledger::BridgeLedger;
use crate::bridge::merkle::{
    compute_index_bits, compute_merkle_root, compute_withdraw_leaf, generate_merkle_proof,
    hash_l2_to_l1_withdraw, WITHDRAW_TREE_DEPTH, ZERO_BYTES_32,
};
use crate::cli::TestWithdrawArgs;
use crate::commands::decode::load_bridge_ledger;
use crate::commands::mock_batch::write_latest_mock_batch;
use crate::executor_client;
use crate::signatures;
use crate::ts_cli;

fn pad_ascii_32(text: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    let src = text.as_bytes();
    let len = src.len().min(32);
    out[..len].copy_from_slice(&src[..len]);
    out
}

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

    let executor_base = args.bridge.executor_url.as_deref();
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

    let total_loops: u32 = args.loops.unwrap_or(1);

    for iteration in 0..total_loops {
        if total_loops > 1 {
            log_progress(&format!("=== loop {}/{} ===", iteration + 1, total_loops));
        }

        if !args.skip_set_verifier_set && iteration == 0 {
            log_progress("sending setVerifierSet...");
            if let Some(base) = executor_base {
                executor_client::set_verifier_set(base).await?;
            } else {
                ts_cli::run_set_verifier_set(&env_args)?;
            }
        }

        let initial_ledger = load_bridge_ledger(&args.bridge).await?;
        let locked_before = initial_ledger.rollup.locked_night;

        log_progress("sending depositNIGHTUnshielded...");
        if let Some(base) = executor_base {
            executor_client::deposit(
                base,
                &deposit_amount.to_string(),
                args.l2_recipient.as_deref(),
                Some(&gas_limit.to_string()),
                Some(&timestamp.to_string()),
            )
            .await?;
        } else {
            ts_cli::run_deposit(
                &env_args,
                &deposit_amount.to_string(),
                args.l2_recipient.as_deref(),
                Some(&gas_limit.to_string()),
                Some(&timestamp.to_string()),
            )?;
        }

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
            current_ledger.rollup.last_committed_batch_hash
        } else {
            let parent_hash = current_ledger.rollup.last_finalized_batch_hash;
            let new_batch_hash = batch::random_bytes32();
            log_progress("sending commitBatch...");
            if let Some(base) = executor_base {
                executor_client::commit_batch(
                    base,
                    &hex::encode(parent_hash),
                    &hex::encode(new_batch_hash),
                )
                .await?;
            } else {
                ts_cli::run_commit_batch(
                    &env_args,
                    &hex::encode(parent_hash),
                    &hex::encode(new_batch_hash),
                )?;
            }
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
        write_latest_mock_batch(&batch_public_data)?;
        let batch_public_data_json = ts_cli::batch_public_data_to_json(&batch_public_data);
        let verifier_keys = signatures::verifier_secret_keys_from_env()?;
        let (signatures_json, _) =
            signatures::build_signatures_json(&batch_public_data, &args.signature_nonce, &verifier_keys)?;

        log_progress("sending finalizeBatch...");
        if let Some(base) = executor_base {
            executor_client::finalize_batch(
                base,
                &batch_public_data_json,
                &signatures_json,
                signer_bitmap,
                finalize_timestamp,
            )
            .await?;
        } else {
            ts_cli::run_finalize_batch(
                &env_args,
                &batch_public_data_json,
                &signatures_json,
                signer_bitmap,
                finalize_timestamp,
            )?;
        }

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
        if let Some(base) = executor_base {
            executor_client::relay_withdraw_night_with_proof(
                base,
                &hex::encode(l2_sender),
                &hex::encode(recipient_address),
                &withdraw_amount.to_string(),
                &batch_public_data.batch_index.to_string(),
                &withdraw_nonce.to_string(),
                &index_bits_json,
                &siblings_json,
            )
            .await?;
        } else {
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
        }

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
        if let Some(base) = executor_base {
            executor_client::claim_l1_withdrawal_unshielded(
                base,
                &hex::encode(recipient_address),
                &claim_amount.to_string(),
            )
            .await?;
        } else {
            ts_cli::run_claim_l1_withdrawal_unshielded(
                &env_args,
                &hex::encode(recipient_address),
                &claim_amount.to_string(),
            )?;
        }

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
            "test-withdraw loop {}/{} completed: recipient={}, deposit={}, withdraw={}, claim={}, pending_after_claim={}",
            iteration + 1,
            total_loops,
            hex::encode(recipient_address),
            deposit_amount,
            withdraw_amount,
            claim_amount,
            final_pending
        );
    }

    Ok(())
}
