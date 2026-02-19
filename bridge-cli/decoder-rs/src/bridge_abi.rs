use anyhow::{anyhow, Result};
use midnight_node_ledger_helpers::base_crypto::fab::{
    AlignedValue, Alignment, AlignmentAtom, Value, ValueAtom,
};
use serde::Serialize;
use midnight_node_ledger_helpers::transient_crypto::curve::Fr;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct CurvePoint {
    pub x: Fr,
    pub y: Fr,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Signature {
    pub pk: CurvePoint,
    pub r: CurvePoint,
    pub s: Fr,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BatchPublicDataV1Full {
    pub version: u32,
    pub layer2_chain_id: u64,
    pub rollup_id: [u8; 32],
    pub batch_index: u64,
    pub da_start_height: u64,
    pub da_end_height: u64,
    pub da_commitment: [u8; 32],
    pub last_processed_queue_index: u64,
    pub message_queue_hash: [u8; 32],
    pub prev_state_root: [u8; 32],
    pub prev_batch_hash: [u8; 32],
    pub post_state_root: [u8; 32],
    pub batch_hash: [u8; 32],
    pub withdraw_root: [u8; 32],
}

pub fn encode_commit_batch(parent_batch_hash: [u8; 32], batch_hash: [u8; 32]) -> Result<AlignedValue> {
    let alignment = Alignment::concat([&bytes32_alignment(), &bytes32_alignment()]);
    let value = Value::concat([&bytes32_value(parent_batch_hash), &bytes32_value(batch_hash)]);
    AlignedValue::new(value, alignment).ok_or_else(|| anyhow!("commitBatch input not aligned"))
}

pub fn encode_finalize_batch(
    batch_public_data: &BatchPublicDataV1Full,
    signatures: &[Signature; 3],
    signer_bitmap: u8,
    finalize_timestamp: u64,
) -> Result<AlignedValue> {
    let alignment = Alignment::concat([
        &batch_public_data_alignment(),
        &signature_vector_alignment(),
        &uint8_alignment(),
        &uint64_alignment(),
    ]);

    let mut values = Vec::new();
    values.push(batch_public_data_value(batch_public_data));
    values.push(signature_vector_value(signatures));
    values.push(uint8_value(signer_bitmap));
    values.push(uint64_value(finalize_timestamp));

    let value = Value::concat(values.iter());
    AlignedValue::new(value, alignment).ok_or_else(|| anyhow!("finalizeBatch input not aligned"))
}

/// Serialize Fr to decimal string (for JSON output to TS bridge-cli).
pub fn fr_to_decimal_string(f: &Fr) -> String {
    use num_bigint::BigUint;
    BigUint::from_bytes_le(&f.0.to_bytes_le()).to_string()
}

pub fn batch_public_data_alignment() -> Alignment {
    Alignment::concat([
        &uint32_alignment(),
        &uint64_alignment(),
        &bytes32_alignment(),
        &uint64_alignment(),
        &uint64_alignment(),
        &uint64_alignment(),
        &bytes32_alignment(),
        &uint64_alignment(),
        &bytes32_alignment(),
        &bytes32_alignment(),
        &bytes32_alignment(),
        &bytes32_alignment(),
        &bytes32_alignment(),
        &bytes32_alignment(),
    ])
}

fn batch_public_data_value(bpd: &BatchPublicDataV1Full) -> Value {
    Value::concat([
        &uint32_value(bpd.version),
        &uint64_value(bpd.layer2_chain_id),
        &bytes32_value(bpd.rollup_id),
        &uint64_value(bpd.batch_index),
        &uint64_value(bpd.da_start_height),
        &uint64_value(bpd.da_end_height),
        &bytes32_value(bpd.da_commitment),
        &uint64_value(bpd.last_processed_queue_index),
        &bytes32_value(bpd.message_queue_hash),
        &bytes32_value(bpd.prev_state_root),
        &bytes32_value(bpd.prev_batch_hash),
        &bytes32_value(bpd.post_state_root),
        &bytes32_value(bpd.batch_hash),
        &bytes32_value(bpd.withdraw_root),
    ])
}

fn signature_vector_alignment() -> Alignment {
    let sig_alignment = signature_alignment();
    let mut alignment = Alignment(Vec::new());
    for _ in 0..3 {
        alignment = Alignment::concat([&alignment, &sig_alignment]);
    }
    alignment
}

fn signature_vector_value(signatures: &[Signature; 3]) -> Value {
    Value::concat([
        &signature_value(&signatures[0]),
        &signature_value(&signatures[1]),
        &signature_value(&signatures[2]),
    ])
}

fn signature_alignment() -> Alignment {
    Alignment::concat([
        &curve_point_alignment(),
        &curve_point_alignment(),
        &field_alignment(),
    ])
}

fn signature_value(sig: &Signature) -> Value {
    Value::concat([
        &curve_point_value(sig.pk),
        &curve_point_value(sig.r),
        &field_value(sig.s),
    ])
}

fn curve_point_alignment() -> Alignment {
    Alignment::concat([&field_alignment(), &field_alignment()])
}

fn curve_point_value(point: CurvePoint) -> Value {
    Value::concat([&field_value(point.x), &field_value(point.y)])
}

fn field_alignment() -> Alignment {
    Alignment::singleton(AlignmentAtom::Field)
}

fn field_value(value: Fr) -> Value {
    Value(vec![ValueAtom::from(value).normalize()])
}

fn uint64_alignment() -> Alignment {
    Alignment::singleton(AlignmentAtom::Bytes { length: 8 })
}

fn uint32_alignment() -> Alignment {
    Alignment::singleton(AlignmentAtom::Bytes { length: 4 })
}

fn uint8_alignment() -> Alignment {
    Alignment::singleton(AlignmentAtom::Bytes { length: 1 })
}

fn uint64_value(value: u64) -> Value {
    field_value(Fr::from(value))
}

fn uint32_value(value: u32) -> Value {
    field_value(Fr::from(u64::from(value)))
}

fn uint8_value(value: u8) -> Value {
    field_value(Fr::from(u64::from(value)))
}

fn bytes32_alignment() -> Alignment {
    Alignment::singleton(AlignmentAtom::Bytes { length: 32 })
}

fn bytes32_value(bytes: [u8; 32]) -> Value {
    Value(vec![ValueAtom(bytes.to_vec()).normalize()])
}

#[cfg(test)]
mod tests {
    use super::*;
    use midnight_node_ledger_helpers::base_crypto::repr::BinaryHashRepr;
    use midnight_node_ledger_helpers::transient_crypto::fab::ValueReprAlignedValue;

    #[test]
    fn encode_commit_batch_keeps_bytes32_order() {
        let mut parent = [0u8; 32];
        let mut batch = [0u8; 32];
        for (idx, byte) in parent.iter_mut().enumerate() {
            *byte = (idx as u8).wrapping_add(1);
        }
        for (idx, byte) in batch.iter_mut().enumerate() {
            *byte = (31 - idx) as u8;
        }

        let aligned = encode_commit_batch(parent, batch).expect("aligned");
        let mut out = Vec::new();
        ValueReprAlignedValue(aligned).binary_repr(&mut out);
        assert_eq!(out.len(), 64);
        assert_eq!(&out[..32], &parent);
        assert_eq!(&out[32..], &batch);
    }
}
