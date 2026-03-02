//! Native Rust signing for Bridge finalize-batch using transient_crypto/base_crypto.
//! Produces signatures that verify on the Bridge contract (Signer.compact).

use anyhow::{Context, Result};
use base_crypto::hash::persistent_hash;
use num_bigint::BigUint;
use num_traits::Zero;
use serde_json::json;
use std::env;
use transient_crypto::curve::{EmbeddedGroupAffine, Fr};
use transient_crypto::hash::degrade_to_transient;

use crate::bridge::abi::BatchPublicDataV1Full;

/// Environment variable for verifier secret keys (comma-separated decimals, e.g. "101,102,103").
/// If unset, [`default_verifier_secret_keys`] are used.
pub const VERIFIER_SECRET_KEYS_ENV: &str = "VERIFIER_SECRET_KEYS";

/// Domain separator for batch digest (pad to 32 bytes).
const BATCH_DOMAIN: &[u8; 32] = b"mdn:bpd:v1full\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0";

/// Default verifier secret keys (must match bridge-cli batch-helpers). Used when [`VERIFIER_SECRET_KEYS_ENV`] is unset.
pub const DEFAULT_VERIFIER_SECRET_KEYS: [u64; 3] = [101, 102, 103];

/// Read verifier secret keys from env or return default. Expects exactly 3 comma-separated decimal values when set.
/// Values can be up to ~255 bits (Jubjub scalar field size).
pub fn verifier_secret_keys_from_env() -> Result<Vec<BigUint>> {
    match env::var(VERIFIER_SECRET_KEYS_ENV) {
        Ok(s) => {
            let keys: Vec<BigUint> = s
                .split(',')
                .map(|p| p.trim())
                .filter(|p| !p.is_empty())
                .map(|p| {
                    BigUint::parse_bytes(p.as_bytes(), 10)
                        .with_context(|| format!("invalid verifier key {:?}", p))
                })
                .collect::<Result<Vec<_>>>()?;
            if keys.len() != 3 {
                anyhow::bail!(
                    "{} must have exactly 3 comma-separated values, got {}",
                    VERIFIER_SECRET_KEYS_ENV,
                    keys.len()
                );
            }
            Ok(keys)
        }
        Err(env::VarError::NotPresent) => Ok(DEFAULT_VERIFIER_SECRET_KEYS
            .iter()
            .map(|&u| BigUint::from(u))
            .collect()),
        Err(e) => Err(anyhow::Error::msg(e.to_string())),
    }
}

/// Scalar field order of the embedded curve (Jubjub). Keys and nonces are reduced mod this.
const JUBJUB_SCALAR_FIELD_DECIMAL: &str =
    "6554484396890773809930967563523245729705921265872317281365359162392183254199";

/// Max bytes for Fr (outer/BLS scalar field); values must fit for `Fr::from_le_bytes`.
const FR_BYTES: usize = 32;

/// Convert a BigUint to Fr after reducing mod q. Used for keys and nonces (Jubjub scalar field).
fn biguint_to_fr_reduced(n: &BigUint, q: &BigUint) -> Option<Fr> {
    let reduced = n % q;
    let bytes = reduced.to_bytes_le();
    if bytes.len() > FR_BYTES {
        return None;
    }
    let mut buf = [0u8; FR_BYTES];
    buf[..bytes.len()].copy_from_slice(&bytes);
    Fr::from_le_bytes(&buf)
}

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

/// Reduce scalar s to the canonical range [0, jubjub_order) for the contract.
/// s is computed in the outer (BLS) scalar field; the contract expects s < Jubjub order.
/// G*s ≡ G*(s mod q) on the curve, so the reduced value is valid for verification.
fn s_reduced_to_decimal(s: &Fr, jubjub_order: &BigUint) -> String {
    let le = s.as_le_bytes();
    let s_big = BigUint::from_bytes_le(&le);
    let reduced = s_big % jubjub_order;
    reduced.to_string()
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

/// Sign msg with sk and nonce; returns a signature that verifies on the contract.
/// We compute s = (nonce + c*sk) in the **Jubjub** scalar field (mod q), not in the outer (BLS) field.
/// Otherwise for large sk, (nonce + c*sk) wraps in the outer field and verification fails
/// (G*(s mod Fq) ≠ G*(nonce + c*sk) on the curve when s wrapped). See curve.rs Mul<Fr> for EmbeddedGroupAffine.
pub(crate) fn sign_bytes32(msg: &[u8; 32], sk: Fr, nonce: Fr) -> Option<BridgeSignature> {
    let g = EmbeddedGroupAffine::generator();
    let pk = g * sk;
    let r_point = g * nonce;
    let pk_t = point_to_tuple(&pk);
    let r_t = point_to_tuple(&r_point);
    let c = compute_challenge(&r_t, &pk_t, msg);

    let q = BigUint::parse_bytes(JUBJUB_SCALAR_FIELD_DECIMAL.as_bytes(), 10)
        .expect("JUBJUB_SCALAR_FIELD_DECIMAL valid");
    let nonce_big = BigUint::from_bytes_le(&nonce.as_le_bytes());
    let sk_big = BigUint::from_bytes_le(&sk.as_le_bytes());
    let c_big = BigUint::from_bytes_le(&c.as_le_bytes());
    let nonce_q = &nonce_big % &q;
    let sk_q = &sk_big % &q;
    let c_q = &c_big % &q;
    let s_big = (nonce_q + c_q * sk_q) % &q;

    let s_bytes = s_big.to_bytes_le();
    let mut s_32 = [0u8; 32];
    let n = s_bytes.len().min(32);
    s_32[..n].copy_from_slice(&s_bytes[..n]);
    let s = Fr::from_le_bytes(&s_32)?;

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
/// Public for tests (verification of build_signatures_json output).
pub(crate) fn verify_bytes32(msg: &[u8; 32], sig: &BridgeSignature) -> bool {
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

/// Build signatures JSON string and the nonces used (same format as batch-helpers signaturesToJson).
/// Uses one nonce per signer: `signature_nonce + 0`, `signature_nonce + 1`, `signature_nonce + 2` (all mod q).
/// Nonce 0 is avoided (r = G*0 would be identity); if `signature_nonce` is 0, base nonce is 1.
/// `signature_nonce` is a decimal string (can be up to ~255 bits). Keys are reduced mod Jubjub order.
pub fn build_signatures_json(
    batch_public_data: &BatchPublicDataV1Full,
    signature_nonce: &str,
    verifier_secret_keys: &[BigUint],
) -> Result<(String, Vec<BigUint>)> {
    if verifier_secret_keys.len() < 3 {
        anyhow::bail!(
            "need at least 3 verifier secret keys, got {}",
            verifier_secret_keys.len()
        );
    }
    let digest = hash_batch_public_data_v1_full(batch_public_data);
    let msg: [u8; 32] = digest;

    let q = BigUint::parse_bytes(JUBJUB_SCALAR_FIELD_DECIMAL.as_bytes(), 10)
        .expect("JUBJUB_SCALAR_FIELD_DECIMAL valid");
    let nonce_big = BigUint::parse_bytes(signature_nonce.trim().as_bytes(), 10)
        .with_context(|| format!("invalid signature_nonce {:?}", signature_nonce))?;
    let base_q = if nonce_big.is_zero() {
        BigUint::from(1u32)
    } else {
        &nonce_big % &q
    };
    let mut sigs = Vec::with_capacity(3);
    let mut nonces_used = Vec::with_capacity(3);
    for (index, sk_big) in verifier_secret_keys.iter().take(3).enumerate() {
        let sk = biguint_to_fr_reduced(sk_big, &q)
            .with_context(|| format!("verifier key {} out of range for signer {}", sk_big, index))?;
        let nonce_i = (&base_q + BigUint::from(index)) % &q;
        let nonce_fr = biguint_to_fr_reduced(&nonce_i, &q).with_context(|| {
            format!("nonce for signer {} out of range", index)
        })?;
        let sig = sign_bytes32(&msg, sk, nonce_fr).with_context(|| {
            format!("sign_bytes32 failed for signer {} with nonce {}", index, nonce_i)
        })?;
        nonces_used.push(nonce_i);
        sigs.push(sig);
    }

    let arr: Vec<serde_json::Value> = sigs
        .iter()
        .map(|sig| {
            json!({
                "pk": { "x": fr_to_decimal(&sig.pk.0), "y": fr_to_decimal(&sig.pk.1) },
                "r": { "x": fr_to_decimal(&sig.r.0), "y": fr_to_decimal(&sig.r.1) },
                "s": s_reduced_to_decimal(&sig.s, &q),
            })
        })
        .collect();
    let json = serde_json::to_string(&arr).context("serialize signatures JSON")?;
    Ok((json, nonces_used))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::abi::BatchPublicDataV1Full;

    /// Minimal fixed batch for testing (no randomness).
    fn minimal_batch_fixture() -> BatchPublicDataV1Full {
        BatchPublicDataV1Full {
            version: 1,
            layer2_chain_id: 0,
            rollup_id: [0u8; 32],
            batch_index: 0,
            da_start_height: 0,
            da_end_height: 0,
            da_commitment: [0u8; 32],
            last_processed_queue_index: 0,
            message_queue_hash: [0u8; 32],
            prev_state_root: [0u8; 32],
            prev_batch_hash: [0u8; 32],
            post_state_root: [0u8; 32],
            batch_hash: [0u8; 32],
            withdraw_root: [0u8; 32],
        }
    }

    /// Parse decimal string to Fr (for verifying JSON signatures). Fails if value does not fit.
    fn decimal_str_to_fr(s: &str) -> Option<Fr> {
        let bytes = BigUint::parse_bytes(s.as_bytes(), 10)?.to_bytes_le();
        let mut buf = [0u8; 32];
        let n = bytes.len().min(32);
        buf[..n].copy_from_slice(&bytes[..n]);
        Fr::from_le_bytes(&buf)
    }

    /// Parse one signature from JSON object (with keys pk.x, pk.y, r.x, r.y, s).
    fn signature_from_json(obj: &serde_json::Value) -> Option<BridgeSignature> {
        let pk = obj.get("pk")?;
        let r = obj.get("r")?;
        let pk_x = decimal_str_to_fr(pk.get("x")?.as_str()?)?;
        let pk_y = decimal_str_to_fr(pk.get("y")?.as_str()?)?;
        let r_x = decimal_str_to_fr(r.get("x")?.as_str()?)?;
        let r_y = decimal_str_to_fr(r.get("y")?.as_str()?)?;
        let s = decimal_str_to_fr(obj.get("s")?.as_str()?)?;
        Some(BridgeSignature {
            pk: (pk_x, pk_y),
            r: (r_x, r_y),
            s,
        })
    }

    fn default_keys() -> Vec<BigUint> {
        DEFAULT_VERIFIER_SECRET_KEYS
            .iter()
            .map(|&u| BigUint::from(u))
            .collect()
    }

    #[test]
    fn build_signatures_json_succeeds_and_verifies() {
        let batch = minimal_batch_fixture();
        let keys = default_keys();
        let (json, _) = build_signatures_json(&batch, "1", &keys).expect("build_signatures_json");
        let arr: Vec<serde_json::Value> = serde_json::from_str(&json).expect("parse JSON");
        assert_eq!(arr.len(), 3, "three signers");

        let digest = hash_batch_public_data_v1_full(&batch);
        for (i, obj) in arr.iter().enumerate() {
            let sig = signature_from_json(obj).unwrap_or_else(|| panic!("parse signature {}", i));
            assert!(verify_bytes32(&digest, &sig), "signature {} verifies", i);
        }
    }

    #[test]
    fn build_signatures_json_deterministic() {
        let batch = minimal_batch_fixture();
        let keys = default_keys();
        let (a, _) = build_signatures_json(&batch, "1", &keys).expect("first call");
        let (b, _) = build_signatures_json(&batch, "1", &keys).expect("second call");
        assert_eq!(a, b, "same input must produce same JSON");
    }

    #[test]
    fn build_signatures_json_large_keys_nonce() {
        let batch = minimal_batch_fixture();
        let large_keys: Vec<BigUint> = [
            "65544843968907738099309675635232457297059212658723172813653591623921832541",
            "655448439689077380993096756352324572970592126587231728136535916239218325419",
            "6554484396890773809930967563523245729705921265872317281365359162392183254198",
        ]
        .iter()
        .map(|s| BigUint::parse_bytes(s.as_bytes(), 10).unwrap())
        .collect();
        let (json, _) = build_signatures_json(&batch, "12345678901234567890", &large_keys)
            .expect("build with large keys and large nonce");
        let arr: Vec<serde_json::Value> = serde_json::from_str(&json).expect("parse JSON");
        assert_eq!(arr.len(), 3);

        let digest = hash_batch_public_data_v1_full(&batch);
        for (i, obj) in arr.iter().enumerate() {
            let sig = signature_from_json(obj).unwrap_or_else(|| panic!("parse signature {}", i));
            assert!(
                verify_bytes32(&digest, &sig),
                "signature {} with very large key must verify",
                i
            );
        }
    }

    #[test]
    fn verify_rejects_tampered_s() {
        let msg = [0u8; 32];
        let sk = Fr::from(101u64);
        let nonce = Fr::from(1u64);
        let mut sig = sign_bytes32(&msg, sk, nonce).expect("valid signature");
        sig.s = sig.s + Fr::from(1u64);
        assert!(!verify_bytes32(&msg, &sig), "tampered s must not verify");
    }

    #[test]
    fn verify_rejects_wrong_message() {
        let msg = [0u8; 32];
        let sk = Fr::from(101u64);
        let nonce = Fr::from(1u64);
        let sig = sign_bytes32(&msg, sk, nonce).expect("valid signature");
        let mut wrong_msg = [0u8; 32];
        wrong_msg[0] = 1;
        assert!(!verify_bytes32(&wrong_msg, &sig), "wrong message must not verify");
    }
}
