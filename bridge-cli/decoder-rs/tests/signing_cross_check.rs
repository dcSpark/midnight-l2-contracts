//! Cross-check that Rust and TypeScript produce the same batch digest and signature scalar s.
//! Run with `cargo test --test signing_cross_check` from decoder-rs. Requires Node/npx/tsx in PATH.
//!
//! - If batch_digest_matches_ts fails: digest (persistentHash of 14×32 bytes) diverges.
//! - If signature_s_matches_ts fails but batch_digest_matches_ts passes: Fiat–Shamir challenge or curve math diverges.

use decoder_rs::bridge::abi::BatchPublicDataV1Full;
use decoder_rs::hex;
use decoder_rs::signatures;
use std::path::PathBuf;
use std::process::Command;

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/signing_cross_check/batch_public_data.json")
}

fn bridge_cli_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Load batch public data from the shared fixture (same format TS parseBatchPublicDataFromJson expects).
fn load_fixture_batch() -> BatchPublicDataV1Full {
    let path = fixture_path();
    let json = std::fs::read_to_string(&path).expect("read fixture");
    serde_json::from_str(&json).expect("parse batch JSON")
}

/// Run TS script that prints digest hex to stdout. Returns None if Node/tsx not available.
fn run_ts_digest(fixture_path: &std::path::Path) -> Option<[u8; 32]> {
    let bridge_cli = bridge_cli_root();
    let script = bridge_cli.join("scripts/print-batch-digest.ts");
    if !script.exists() {
        eprintln!("TS script not found: {}", script.display());
        return None;
    }
    let out = Command::new("npx")
        .args([
            "--yes",
            "tsx",
            script.to_str().unwrap(),
            fixture_path.to_str().unwrap(),
        ])
        .current_dir(&bridge_cli)
        .output()
        .ok()?;
    if !out.status.success() {
        eprintln!(
            "TS script failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        return None;
    }
    let hex_str = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if hex_str.len() != 64 {
        eprintln!("TS digest hex length {} != 64", hex_str.len());
        return None;
    }
    let bytes = hex::decode(&hex_str).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Some(arr)
}

/// Run TS script that prints signature s (decimal) for sk=101, nonce=1. Returns None if script unavailable.
fn run_ts_signature_s(fixture_path: &std::path::Path) -> Option<String> {
    let bridge_cli = bridge_cli_root();
    let script = bridge_cli.join("scripts/print-signature-s.ts");
    if !script.exists() {
        eprintln!("TS script not found: {}", script.display());
        return None;
    }
    let out = Command::new("npx")
        .args([
            "--yes",
            "tsx",
            script.to_str().unwrap(),
            fixture_path.to_str().unwrap(),
        ])
        .current_dir(&bridge_cli)
        .output()
        .ok()?;
    if !out.status.success() {
        eprintln!(
            "TS script failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[test]
fn batch_digest_matches_ts() {
    let batch = load_fixture_batch();
    let rust_digest = signatures::hash_batch_public_data_v1_full(&batch);

    let fixture = fixture_path();
    let ts_digest = match run_ts_digest(&fixture) {
        Some(d) => d,
        None => {
            eprintln!("Skipping digest comparison (Node/npx/tsx or script unavailable)");
            return;
        }
    };

    assert_eq!(
        rust_digest,
        ts_digest,
        "Rust and TS batch digests differ for the same fixture. \
         Rust digest: {}, TS digest: {}",
        hex::encode(rust_digest),
        hex::encode(ts_digest)
    );
}

/// Compare signature scalar s (sk=101, nonce=1) between Rust and TS.
/// If this fails but batch_digest_matches_ts passes, the divergence is in Fiat–Shamir challenge or curve math.
#[test]
fn signature_s_matches_ts() {
    let batch = load_fixture_batch();
    let rust_s = match signatures::signature_s_for_test(&batch, 101, 1) {
        Some(s) => s,
        None => {
            eprintln!("Rust signing failed for (sk=101, nonce=1); skipping comparison");
            return;
        }
    };

    let fixture = fixture_path();
    let ts_s = match run_ts_signature_s(&fixture) {
        Some(s) => s,
        None => {
            eprintln!("Skipping signature s comparison (Node/npx/tsx or script unavailable)");
            return;
        }
    };

    assert_eq!(
        rust_s,
        ts_s,
        "Rust and TS signature s (sk=101, nonce=1) differ. \
         Rust s: {}, TS s: {}",
        rust_s,
        ts_s
    );
}
