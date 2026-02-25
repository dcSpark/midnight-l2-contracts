//! Native Rust signing for Bridge finalize-batch using transient_crypto/base_crypto.
//! Produces signatures that verify on the Bridge contract (Signer.compact).
//! Encoding matches bridge-cli/docs/signing-encoding-spec.md.

use anyhow::{Context, Result};
use base_crypto::hash::persistent_hash;
use num_bigint::BigUint;
use serde_json::json;
use transient_crypto::curve::{EmbeddedGroupAffine, Fr};
use transient_crypto::hash::degrade_to_transient;

use crate::bridge::abi::BatchPublicDataV1Full;

/// Domain separator for batch digest (pad to 32 bytes).
const BATCH_DOMAIN: &[u8; 32] = b"mdn:bpd:v1full\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0";

/// Default verifier secret keys (must match bridge-cli batch-helpers).
const DEFAULT_VERIFIER_SECRET_KEYS: [u64; 3] = [101, 102, 103];

/// Signature shape matching Bridge.Signature (pk, r as points; s as scalar).
#[derive(Clone, Debug)]
pub struct BridgeSignature {
    pub pk: (Fr, Fr),
    pub r: (Fr, Fr),
    pub s: Fr,
}

fn fr_to_bytes32(f: &Fr) -> [u8; 32] {
    let le = f.as_le_bytes();
    let mut out = [0u8; 32];
    let n = le.len().min(32);
    out[..n].copy_from_slice(&le[..n]);
    out
}

fn point_to_tuple(p: &EmbeddedGroupAffine) -> (Fr, Fr) {
    let x = p.x().unwrap_or(Fr::from(0u64));
    let y = p.y().unwrap_or(Fr::from(0u64));
    (x, y)
}

/// Fr to decimal string for JSON (matches TS bigint.toString()).
fn fr_to_decimal(f: &Fr) -> String {
    let le = f.as_le_bytes();
    BigUint::from_bytes_le(&le).to_string()
}

/// Build challenge bytes for Fiat–Shamir: r.x || r.y || pk.x || pk.y || msg (each field as 32-byte LE).
fn challenge_preimage(r: &(Fr, Fr), pk: &(Fr, Fr), msg: &[u8; 32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 * 32 + 32);
    out.extend_from_slice(&fr_to_bytes32(&r.0));
    out.extend_from_slice(&fr_to_bytes32(&r.1));
    out.extend_from_slice(&fr_to_bytes32(&pk.0));
    out.extend_from_slice(&fr_to_bytes32(&pk.1));
    out.extend_from_slice(msg);
    out
}

/// Compute challenge scalar c = degrade_to_transient(persistent_hash(Challenge { r, pk, msg })).
fn compute_challenge(r: &(Fr, Fr), pk: &(Fr, Fr), msg: &[u8; 32]) -> Fr {
    let preimage = challenge_preimage(r, pk, msg);
    let hash = persistent_hash(&preimage);
    degrade_to_transient(hash)
}

/// Batch digest = persistent_hash(14 × Bytes<32>) matching contract L1Rollup.hashBatchPublicDataV1Full.
/// Public for debugging (e.g. --print-digest) and tests.
pub fn hash_batch_public_data_v1_full(b: &BatchPublicDataV1Full) -> [u8; 32] {
    let mut preimage = Vec::with_capacity(14 * 32);
    preimage.extend_from_slice(BATCH_DOMAIN);
    preimage.extend_from_slice(&u64_to_bytes32(b.version as u64));
    preimage.extend_from_slice(&u64_to_bytes32(b.layer2_chain_id));
    preimage.extend_from_slice(&b.rollup_id);
    preimage.extend_from_slice(&u64_to_bytes32(b.batch_index));
    preimage.extend_from_slice(&u64_to_bytes32(b.da_start_height));
    preimage.extend_from_slice(&u64_to_bytes32(b.da_end_height));
    preimage.extend_from_slice(&b.da_commitment);
    preimage.extend_from_slice(&u64_to_bytes32(b.last_processed_queue_index));
    preimage.extend_from_slice(&b.message_queue_hash);
    preimage.extend_from_slice(&b.prev_state_root);
    preimage.extend_from_slice(&b.prev_batch_hash);
    preimage.extend_from_slice(&b.post_state_root);
    preimage.extend_from_slice(&b.withdraw_root);
    let out = persistent_hash(&preimage);
    out.0
}

fn u64_to_bytes32(v: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[0..8].copy_from_slice(&v.to_le_bytes());
    out
}

/// Sign msg with sk and nonce; returns signature or None if s would be invalid for the curve.
fn sign_bytes32(msg: &[u8; 32], sk: Fr, nonce: Fr) -> Option<BridgeSignature> {
    let g = EmbeddedGroupAffine::generator();
    let pk = g * sk;
    let r_point = g * nonce;
    let pk_t = point_to_tuple(&pk);
    let r_t = point_to_tuple(&r_point);
    let c = compute_challenge(&r_t, &pk_t, msg);
    let s = nonce + (c * sk);
    let sig = BridgeSignature {
        pk: pk_t,
        r: r_t,
        s,
    };
    if verify_bytes32(msg, &sig) {
        Some(sig)
    } else {
        None
    }
}

/// Verify signature: G*s == r + pk*c.
fn verify_bytes32(msg: &[u8; 32], sig: &BridgeSignature) -> bool {
    let pk_point = match EmbeddedGroupAffine::new(sig.pk.0, sig.pk.1) {
        Some(p) => p,
        None => return false,
    };
    let r_point = match EmbeddedGroupAffine::new(sig.r.0, sig.r.1) {
        Some(p) => p,
        None => return false,
    };
    let c = compute_challenge(&sig.r, &sig.pk, msg);
    let g = EmbeddedGroupAffine::generator();
    let lhs = g * sig.s;
    let rhs = r_point + (pk_point * c);
    lhs == rhs
}

/// Build signatures JSON string (same format as batch-helpers signaturesToJson) using native Rust.
pub fn build_signatures_json(
    batch_public_data: &BatchPublicDataV1Full,
    signature_max_nonce: u64,
) -> Result<String> {
    let digest = hash_batch_public_data_v1_full(batch_public_data);
    let msg: [u8; 32] = digest;

    let mut sigs = Vec::with_capacity(3);
    for (index, &sk_u64) in DEFAULT_VERIFIER_SECRET_KEYS.iter().enumerate() {
        let sk = Fr::from(sk_u64);
        let mut found = None;
        // Skip nonce 0 so r = G*nonce is never the identity point (0,1); contract may reject identity r.
        for nonce in 1..signature_max_nonce {
            let nonce_fr = Fr::from(nonce);
            if let Some(sig) = sign_bytes32(&msg, sk, nonce_fr) {
                found = Some(sig);
                break;
            }
        }
        let sig = found.with_context(|| {
            format!(
                "no valid signature for signer {} after {} nonces",
                index, signature_max_nonce
            )
        })?;
        sigs.push(sig);
    }

    let arr: Vec<serde_json::Value> = sigs
        .iter()
        .map(|s| {
            json!({
                "pk": { "x": fr_to_decimal(&s.pk.0), "y": fr_to_decimal(&s.pk.1) },
                "r": { "x": fr_to_decimal(&s.r.0), "y": fr_to_decimal(&s.r.1) },
                "s": fr_to_decimal(&s.s),
            })
        })
        .collect();
    serde_json::to_string(&arr).context("serialize signatures JSON")
}
