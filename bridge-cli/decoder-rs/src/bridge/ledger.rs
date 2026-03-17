use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};

#[derive(Debug, Serialize)]
pub struct BridgeLedger {
    pub rollup: RollupLedger,
    pub l2_gateway: L2GatewayLedger,
    pub l2_messenger: L2MessengerLedger,
    pub l2_message_queue: L2MessageQueueLedger,
}

#[derive(Debug, Serialize)]
pub struct RollupLedger {
    pub owner: [u8; 32],
    pub layer2_chain_id: u64,
    pub rollup_id: [u8; 32],
    pub verifier_set: [CurvePoint; 3],
    pub signature_threshold: u8,
    pub sequencers: BTreeSet<[u8; 32]>,
    pub finalizers: BTreeSet<[u8; 32]>,
    pub initialized: bool,
    pub last_committed_batch_hash: [u8; 32],
    pub last_finalized_state_root: [u8; 32],
    pub last_finalized_batch_hash: [u8; 32],
    pub withdraw_roots: BTreeMap<u64, [u8; 32]>,
    pub misc_data: RollupMiscData,
    pub first_cross_domain_message_index: u64,
    pub next_cross_domain_message_index: u64,
    pub next_unfinalized_queue_index: u64,
    pub message_rolling_hashes: BTreeMap<u64, [u8; 32]>,
    pub message_timestamps: BTreeMap<u64, u64>,
    pub l1_to_l2_deposits: BTreeMap<u64, Deposit>,
    pub executed_l2_to_l1_messages: BTreeSet<[u8; 32]>,
    pub locked_night: u128,
    pub fee_vault: u128,
    #[serde(serialize_with = "serialize_hex_key_map")]
    pub pending_withdrawals: BTreeMap<[u8; 32], u128>,
}

#[derive(Clone, Debug, Serialize)]
pub struct RollupMiscData {
    pub last_committed_batch_index: u64,
    pub last_finalized_batch_index: u64,
    pub last_finalize_timestamp: u64,
    pub flags: u8,
    pub reserved: [u8; 11],
}

#[derive(Clone, Debug, Serialize)]
pub struct CurvePoint {
    pub x: [u8; 32],
    pub y: [u8; 32],
}

#[derive(Debug, Serialize)]
pub struct L2GatewayLedger {
    #[serde(serialize_with = "serialize_hex_key_map")]
    pub balances: BTreeMap<[u8; 32], u128>,
}

#[derive(Debug, Serialize)]
pub struct L2MessengerLedger {
    pub last_processed_l1_index: u64,
    pub x_domain_message_sender: [u8; 32],
}

#[derive(Debug, Serialize)]
pub struct L2MessageQueueLedger {
    pub message_count: u64,
    pub withdraw_root: [u8; 32],
    pub branches: Vec<[u8; 32]>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Deposit {
    pub sender: [u8; 32],
    pub recipient: [u8; 32],
    pub amount: u128,
    pub nonce: u64,
    pub gas_limit: u64,
    pub data_hash: [u8; 32],
}

impl fmt::Display for Deposit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{{ sender: {}, recipient: {}, amount: {}, nonce: {}, gasLimit: {}, dataHash: {} }}",
            hex::encode(self.sender),
            hex::encode(self.recipient),
            self.amount,
            self.nonce,
            self.gas_limit,
            hex::encode(self.data_hash)
        )
    }
}

fn serialize_hex_key_map<S: Serializer, V: Serialize>(
    map: &BTreeMap<[u8; 32], V>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let mut m = serializer.serialize_map(Some(map.len()))?;
    for (k, v) in map {
        m.serialize_entry(&hex::encode(k), v)?;
    }
    m.end()
}
