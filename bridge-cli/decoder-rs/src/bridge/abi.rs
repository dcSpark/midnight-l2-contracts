use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchPublicDataV1Full {
    pub version: u32,
    pub layer2_chain_id: u64,
    #[serde(with = "bytes32_hex")]
    pub rollup_id: [u8; 32],
    pub batch_index: u64,
    pub da_start_height: u64,
    pub da_end_height: u64,
    #[serde(with = "bytes32_hex")]
    pub da_commitment: [u8; 32],
    pub last_processed_queue_index: u64,
    #[serde(with = "bytes32_hex")]
    pub message_queue_hash: [u8; 32],
    #[serde(with = "bytes32_hex")]
    pub prev_state_root: [u8; 32],
    #[serde(with = "bytes32_hex")]
    pub prev_batch_hash: [u8; 32],
    #[serde(with = "bytes32_hex")]
    pub post_state_root: [u8; 32],
    #[serde(with = "bytes32_hex")]
    pub batch_hash: [u8; 32],
    #[serde(with = "bytes32_hex")]
    pub withdraw_root: [u8; 32],
}

mod bytes32_hex {
    use super::*;
    use serde::de::Error as _;

    pub fn serialize<S>(value: &[u8; 32], serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&hex::encode(value))
    }

    pub fn deserialize<'de, D>(deserializer: D) -> std::result::Result<[u8; 32], D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        decode_hex_32(&raw).map_err(D::Error::custom)
    }

    fn decode_hex_32(raw: &str) -> std::result::Result<[u8; 32], String> {
        let normalized = raw.strip_prefix("0x").unwrap_or(raw).trim();
        let bytes = hex::decode(normalized).map_err(|err| format!("invalid hex: {err}"))?;
        if bytes.len() != 32 {
            return Err(format!("expected 32-byte hex string, got {} bytes", bytes.len()));
        }
        let mut out = [0u8; 32];
        out.copy_from_slice(&bytes);
        Ok(out)
    }
}
