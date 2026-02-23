//! HTTP client for the executor service (bridge-cli executor).

use anyhow::{Context, Result};
use serde_json::json;

fn base(base_url: &str, path: &str) -> String {
    let base = base_url.trim_end_matches('/');
    format!("{}{}", base, path)
}

async fn post_json<T: serde::de::DeserializeOwned>(
    base_url: &str,
    path: &str,
    body: &serde_json::Value,
) -> Result<T> {
    let url = base(base_url, path);
    let client = reqwest::Client::new();
    let res = client
        .post(&url)
        .json(body)
        .send()
        .await
        .context("executor HTTP request failed")?;
    let status = res.status();
    let body_bytes = res.bytes().await.context("executor response body read failed")?;
    if !status.is_success() {
        let msg = String::from_utf8_lossy(&body_bytes);
        let err_msg: String = serde_json::from_str(&msg).ok().and_then(|v: serde_json::Value| v.get("error").and_then(|e| e.as_str()).map(String::from)).unwrap_or_else(|| msg.into_owned());
        anyhow::bail!("executor {}: {} (status {})", path, err_msg.trim(), status);
    }
    serde_json::from_slice(&body_bytes).context("executor response JSON parse failed")
}

#[allow(dead_code)]
async fn get_json<T: serde::de::DeserializeOwned>(base_url: &str, path: &str) -> Result<T> {
    let url = base(base_url, path);
    let client = reqwest::Client::new();
    let res = client
        .get(&url)
        .send()
        .await
        .context("executor HTTP request failed")?;
    let status = res.status();
    let body_bytes = res.bytes().await.context("executor response body read failed")?;
    if !status.is_success() {
        let msg = String::from_utf8_lossy(&body_bytes);
        anyhow::bail!("executor {}: {} (status {})", path, msg.trim(), status);
    }
    serde_json::from_slice(&body_bytes).context("executor response JSON parse failed")
}

pub async fn commit_batch(
    base_url: &str,
    parent_hash: &str,
    batch_hash: &str,
) -> Result<()> {
    let body = json!({
        "parentHash": parent_hash,
        "batchHash": batch_hash,
    });
    let _: serde_json::Value = post_json(base_url, "/commit-batch", &body).await?;
    Ok(())
}

pub async fn finalize_batch(
    base_url: &str,
    batch_public_data_json: &str,
    signatures_json: &str,
    signer_bitmap: u8,
    finalize_timestamp: u64,
) -> Result<()> {
    let batch_public_data: serde_json::Value =
        serde_json::from_str(batch_public_data_json).context("batch_public_data JSON")?;
    let signatures: serde_json::Value =
        serde_json::from_str(signatures_json).context("signatures JSON")?;
    let body = json!({
        "batchPublicData": batch_public_data,
        "signatures": signatures,
        "signerBitmap": signer_bitmap,
        "finalizeTimestamp": finalize_timestamp,
    });
    let _: serde_json::Value = post_json(base_url, "/finalize-batch", &body).await?;
    Ok(())
}

pub async fn build_signatures(base_url: &str, batch_public_data_json: &str, signature_max_nonce: u64) -> Result<String> {
    let batch_public_data: serde_json::Value =
        serde_json::from_str(batch_public_data_json).context("batch_public_data JSON")?;
    let body = json!({
        "batchPublicData": batch_public_data,
        "signatureMaxNonce": signature_max_nonce,
    });
    #[derive(serde::Deserialize)]
    struct Out {
        signatures: String,
    }
    let out: Out = post_json(base_url, "/build-signatures", &body).await?;
    Ok(out.signatures)
}

#[derive(serde::Deserialize)]
pub struct DepositResponse {
    pub tx_hash: String,
}

pub async fn deposit(
    base_url: &str,
    amount: &str,
    l2_recipient: Option<&str>,
    gas_limit: Option<&str>,
    timestamp: Option<&str>,
) -> Result<DepositResponse> {
    let mut body = json!({ "amount": amount });
    if let Some(r) = l2_recipient {
        body["l2Recipient"] = json!(r);
    }
    if let Some(g) = gas_limit {
        body["gasLimit"] = json!(g);
    }
    if let Some(t) = timestamp {
        body["timestamp"] = json!(t);
    }
    #[derive(serde::Deserialize)]
    struct Raw {
        #[serde(rename = "txHash")]
        tx_hash: Option<String>,
    }
    let raw: Raw = post_json(base_url, "/deposit", &body).await?;
    let tx_hash = raw.tx_hash.unwrap_or_default();
    Ok(DepositResponse { tx_hash })
}

pub async fn set_verifier_set(base_url: &str) -> Result<()> {
    let body = json!({});
    let _: serde_json::Value = post_json(base_url, "/set-verifier-set", &body).await?;
    Ok(())
}

pub async fn relay_withdraw_night_with_proof(
    base_url: &str,
    l2_sender: &str,
    recipient: &str,
    amount: &str,
    batch_index: &str,
    nonce: &str,
    index_bits: &str,
    siblings: &str,
) -> Result<()> {
    let body = json!({
        "l2Sender": l2_sender,
        "recipient": recipient,
        "amount": amount,
        "batchIndex": batch_index,
        "nonce": nonce,
        "indexBits": index_bits,
        "siblings": siblings,
    });
    let _: serde_json::Value = post_json(base_url, "/relay-withdraw-night-with-proof", &body).await?;
    Ok(())
}

pub async fn claim_l1_withdrawal_unshielded(
    base_url: &str,
    recipient: &str,
    amount: &str,
) -> Result<()> {
    let body = json!({
        "recipient": recipient,
        "amount": amount,
    });
    let _: serde_json::Value = post_json(base_url, "/claim-l1-withdrawal-unshielded", &body).await?;
    Ok(())
}

#[allow(dead_code)]
pub async fn test_withdraw(
    base_url: &str,
    deposit_amount: Option<&str>,
    withdraw_amount: Option<&str>,
    claim_amount: Option<&str>,
    recipient: Option<&str>,
    l2_sender: Option<&str>,
    l2_recipient: Option<&str>,
    gas_limit: Option<&str>,
    timestamp: Option<&str>,
    signer_bitmap: Option<u8>,
    finalize_timestamp: Option<u64>,
    skip_set_verifier_set: bool,
    wait_attempts: u32,
    wait_delay_ms: u64,
) -> Result<()> {
    let mut body = serde_json::Map::new();
    if let Some(a) = deposit_amount {
        body.insert("depositAmount".into(), json!(a));
    }
    if let Some(a) = withdraw_amount {
        body.insert("withdrawAmount".into(), json!(a));
    }
    if let Some(a) = claim_amount {
        body.insert("claimAmount".into(), json!(a));
    }
    if let Some(r) = recipient {
        body.insert("recipient".into(), json!(r));
    }
    if let Some(s) = l2_sender {
        body.insert("l2Sender".into(), json!(s));
    }
    if let Some(r) = l2_recipient {
        body.insert("l2Recipient".into(), json!(r));
    }
    if let Some(g) = gas_limit {
        body.insert("gasLimit".into(), json!(g));
    }
    if let Some(t) = timestamp {
        body.insert("timestamp".into(), json!(t));
    }
    if let Some(b) = signer_bitmap {
        body.insert("signerBitmap".into(), json!(b));
    }
    if let Some(t) = finalize_timestamp {
        body.insert("finalizeTimestamp".into(), json!(t));
    }
    body.insert("skipSetVerifierSet".into(), json!(skip_set_verifier_set));
    body.insert("waitAttempts".into(), json!(wait_attempts));
    body.insert("waitDelayMs".into(), json!(wait_delay_ms));
    let body = serde_json::Value::Object(body);
    let _: serde_json::Value = post_json(base_url, "/test-withdraw", &body).await?;
    Ok(())
}
