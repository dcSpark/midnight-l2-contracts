use anyhow::{anyhow, Result};

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

    let rust_signatures_json =
        signatures::build_signatures_json(&batch_public_data, args.signature_max_nonce)?;

    let signatures_json = if let Some(ref base) = args.bridge.executor_url {
        let ts_signatures_json =
            executor_client::build_signatures(base, &batch_public_data_json, args.signature_max_nonce).await?;
        if let Err(e) = compare_signatures_json(&rust_signatures_json, &ts_signatures_json) {
            log_signature_diff(&rust_signatures_json, &ts_signatures_json);
            return Err(e);
        }
        ts_signatures_json
    } else {
        rust_signatures_json
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

/// Log full side-by-side diff of Rust vs TS signatures to stderr for debugging.
fn log_signature_diff(rust_json: &str, ts_json: &str) {
    let rust_sigs: Vec<serde_json::Value> = match serde_json::from_str(rust_json) {
        Ok(s) => s,
        Err(_) => return,
    };
    let ts_sigs: Vec<serde_json::Value> = match serde_json::from_str(ts_json) {
        Ok(s) => s,
        Err(_) => return,
    };
    let canonical = |v: Option<&serde_json::Value>| -> String {
        match v {
            Some(serde_json::Value::Number(n)) => n.to_string(),
            Some(serde_json::Value::String(s)) => s.clone(),
            _ => "missing".to_string(),
        }
    };
    eprintln!("[signing] --- Rust vs TS signature diff ---");
    for (i, (r, t)) in rust_sigs.iter().zip(ts_sigs.iter()).enumerate() {
        for (name, rv, tv) in [
            ("pk.x", r.get("pk").and_then(|p| p.get("x")), t.get("pk").and_then(|p| p.get("x"))),
            ("pk.y", r.get("pk").and_then(|p| p.get("y")), t.get("pk").and_then(|p| p.get("y"))),
            ("r.x", r.get("r").and_then(|p| p.get("x")), t.get("r").and_then(|p| p.get("x"))),
            ("r.y", r.get("r").and_then(|p| p.get("y")), t.get("r").and_then(|p| p.get("y"))),
            ("s", r.get("s"), t.get("s")),
        ] {
            let rs = canonical(rv);
            let ts = canonical(tv);
            let eq = if rs == ts { "ok" } else { "DIFF" };
            eprintln!("[signing]   signer {} {}: {} Rust={} TS={}", i, name, eq, rs, ts);
        }
    }
    eprintln!("[signing] --- end diff ---");
}

/// Compare Rust-built and TS-built signatures JSON; return Err with details on first difference.
fn compare_signatures_json(rust_json: &str, ts_json: &str) -> Result<()> {
    let rust_sigs: Vec<serde_json::Value> =
        serde_json::from_str(rust_json).map_err(|e| anyhow!("Rust signatures JSON: {}", e))?;
    let ts_sigs: Vec<serde_json::Value> =
        serde_json::from_str(ts_json).map_err(|e| anyhow!("TS signatures JSON: {}", e))?;
    if rust_sigs.len() != ts_sigs.len() {
        return Err(anyhow!(
            "Rust vs TS signatures: length {} vs {}",
            rust_sigs.len(),
            ts_sigs.len()
        ));
    }
    for (i, (r, t)) in rust_sigs.iter().zip(ts_sigs.iter()).enumerate() {
        let fields = [
            ("pk.x", r.get("pk").and_then(|p| p.get("x")), t.get("pk").and_then(|p| p.get("x"))),
            ("pk.y", r.get("pk").and_then(|p| p.get("y")), t.get("pk").and_then(|p| p.get("y"))),
            ("r.x", r.get("r").and_then(|p| p.get("x")), t.get("r").and_then(|p| p.get("x"))),
            ("r.y", r.get("r").and_then(|p| p.get("y")), t.get("r").and_then(|p| p.get("y"))),
            ("s", r.get("s"), t.get("s")),
        ];
        for (name, rv, tv) in fields {
            let canonical = |v: Option<&serde_json::Value>| -> String {
                match v {
                    Some(serde_json::Value::Number(n)) => n.to_string(),
                    Some(serde_json::Value::String(s)) => s.clone(),
                    _ => "missing".to_string(),
                }
            };
            let rs = canonical(rv);
            let ts = canonical(tv);
            if rs != ts {
                return Err(anyhow!(
                    "Rust vs TS signatures differ at signer {} field {}: Rust {} vs TS {}",
                    i,
                    name,
                    rs,
                    ts
                ));
            }
        }
    }
    Ok(())
}
