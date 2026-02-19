use anyhow::{anyhow, Result};
use midnight_node_ledger_helpers::base_crypto::fab::{AlignedValue, Alignment, Value, ValueAtom};
use midnight_node_ledger_helpers::base_crypto::fab::Aligned;
use midnight_node_ledger_helpers::base_crypto::hash::PersistentHashWriter;
use midnight_node_ledger_helpers::base_crypto::repr::BinaryHashRepr;
use midnight_node_ledger_helpers::transient_crypto::curve::{EmbeddedGroupAffine, Fr};
use midnight_node_ledger_helpers::transient_crypto::fab::ValueReprAlignedValue;
use midnight_node_ledger_helpers::transient_crypto::hash::{
    HashOutput as TransientHashOutput, degrade_to_transient,
};

use crate::bridge_abi::{CurvePoint, Signature};

pub fn sign_bytes32(message: [u8; 32], secret_key: Fr, nonce: Fr) -> Signature {
    let generator = EmbeddedGroupAffine::generator();
    let pk = generator * secret_key;
    let r = generator * nonce;
    let c = compute_challenge(message, pk, r);
    let s = nonce + (c * secret_key);
    Signature {
        pk: curve_point_from_affine(pk),
        r: curve_point_from_affine(r),
        s,
    }
}

pub fn verify_bytes32(message: [u8; 32], signature: &Signature) -> Result<bool> {
    let pk = embedded_from_curve_point(signature.pk)?;
    let r = embedded_from_curve_point(signature.r)?;
    let c = compute_challenge(message, pk, r);
    let lhs = EmbeddedGroupAffine::generator() * signature.s;
    let rhs = r + (pk * c);
    Ok(lhs == rhs)
}

pub fn sign_with_nonce_retry(
    message: [u8; 32],
    secret_key: Fr,
    signer_index: usize,
    max_nonce: u64,
) -> Result<Signature> {
    let mut last_error: Option<anyhow::Error> = None;
    for nonce in 0..max_nonce {
        let signature = sign_bytes32(message, secret_key, Fr::from(nonce));
        match verify_bytes32(message, &signature) {
            Ok(true) => {
                println!("Signer {} produced signature with nonce={}.", signer_index, nonce);
                return Ok(signature);
            }
            Ok(false) => {
                last_error = Some(anyhow!("signature verification failed for nonce {}", nonce));
            }
            Err(err) => {
                last_error = Some(err);
            }
        }
    }
    Err(last_error.unwrap_or_else(|| {
        anyhow!(
            "Unable to produce a valid signature for signer {} after {} nonces",
            signer_index,
            max_nonce
        )
    }))
}

fn compute_challenge(message: [u8; 32], pk: EmbeddedGroupAffine, r: EmbeddedGroupAffine) -> Fr {
    let alignment = Alignment::concat([
        &EmbeddedGroupAffine::alignment(),
        &EmbeddedGroupAffine::alignment(),
        &bytes32_alignment(),
    ]);
    let msg_value = Value(vec![ValueAtom(message.to_vec()).normalize()]);
    let value = Value::concat([&Value::from(r), &Value::from(pk), &msg_value]);
    let aligned = AlignedValue::new(value, alignment)
        .expect("aligned value for signature challenge should be valid");
    let mut hasher = PersistentHashWriter::default();
    ValueReprAlignedValue(aligned).binary_repr(&mut hasher);
    let hash = hasher.finalize();
    degrade_to_transient(TransientHashOutput(hash.0))
}

fn curve_point_from_affine(point: EmbeddedGroupAffine) -> CurvePoint {
    let x = point.x().unwrap_or(Fr::from(0u64));
    let y = point.y().unwrap_or(Fr::from(1u64));
    CurvePoint { x, y }
}

fn embedded_from_curve_point(point: CurvePoint) -> Result<EmbeddedGroupAffine> {
    if point.x == Fr::from(0u64) && point.y == Fr::from(1u64) {
        return Ok(EmbeddedGroupAffine::identity());
    }
    EmbeddedGroupAffine::new(point.x, point.y)
        .ok_or_else(|| anyhow!("invalid curve point"))
}

fn bytes32_alignment() -> Alignment {
    Alignment::singleton(midnight_node_ledger_helpers::base_crypto::fab::AlignmentAtom::Bytes {
        length: 32,
    })
}
