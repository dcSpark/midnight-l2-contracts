use std::io::Write;
use std::path::Path;

use anyhow::{Context, Result};
use base_crypto::fab::AlignedValue;
use midnight_onchain_state::state::{
    ContractMaintenanceAuthority, ContractOperation, ContractState, EntryPointBuf, StateValue,
};
use midnight_storage::storage::{Array, HashMap};
use midnight_storage::DefaultDB;
use midnight_storage::arena::Sp;
use serialize::tagged_serialize;

type SV = StateValue<DefaultDB>;

#[derive(Clone)]
pub struct BridgeStateConfig {
    pub num_deposits: u64,
    pub num_sequencers: u64,
    pub num_finalizers: u64,
    pub num_withdraw_roots: u64,
    pub num_message_hashes: u64,
    pub num_executed_messages: u64,
    pub num_pending_withdrawals: u64,
    pub owner: [u8; 32],
    pub locked_night: u128,
    pub fee_vault: u128,
    pub last_finalized_batch_hash: [u8; 32],
    pub l2_gateway_balances: Vec<([u8; 32], u128)>,
    /// Verifier set: up to 3 public key (x, y) pairs as 32-byte LE arrays.
    /// Empty = all-zeros verifier set.
    pub verifier_set: Vec<([u8; 32], [u8; 32])>,
    pub signature_threshold: u8,
    pub last_committed_batch_hash: [u8; 32],
    /// When Some(n), sets miscData.lastCommittedBatchIndex to n (allowing it to differ
    /// from lastFinalizedBatchIndex). None = same as finalized (for commitBatch compatibility).
    pub last_committed_batch_index: Option<u64>,
    /// Explicit batchIndex -> withdrawRoot entries, merged into the withdrawRoots map
    /// alongside the `num_withdraw_roots` synthetic entries.
    pub specific_withdraw_roots: Vec<(u64, [u8; 32])>,
    pub last_finalized_state_root: [u8; 32],
    /// Additional Bytes<32> entries to insert into the sequencers set
    /// (beyond the `num_sequencers` synthetic ones).
    pub extra_sequencers: Vec<[u8; 32]>,
    /// Additional Bytes<32> entries to insert into the finalizers set.
    pub extra_finalizers: Vec<[u8; 32]>,
}

impl Default for BridgeStateConfig {
    fn default() -> Self {
        Self {
            num_deposits: 0,
            num_sequencers: 0,
            num_finalizers: 0,
            num_withdraw_roots: 0,
            num_message_hashes: 0,
            num_executed_messages: 0,
            num_pending_withdrawals: 0,
            owner: [0u8; 32],
            locked_night: 0,
            fee_vault: 0,
            last_finalized_batch_hash: [0u8; 32],
            l2_gateway_balances: Vec::new(),
            verifier_set: Vec::new(),
            signature_threshold: 0,
            last_committed_batch_hash: [0u8; 32],
            last_committed_batch_index: None,
            specific_withdraw_roots: Vec::new(),
            last_finalized_state_root: [0u8; 32],
            extra_sequencers: Vec::new(),
            extra_finalizers: Vec::new(),
        }
    }
}

/// Build a `ContractState<DefaultDB>` with configurable population of all
/// Bridge contract storage fields.
///
/// The state tree layout mirrors the Bridge contract as decoded by
/// `decode_bridge_ledger` in `commands/decode.rs`:
///
/// ```text
/// root = Array[3]
///   [0] = rollup_head  (Array[13])
///   [1] = rollup_tail  (Array[15])
///   [2] = branch_nodes (Array[15])
/// ```
pub fn build_bridge_state(config: &BridgeStateConfig) -> ContractState<DefaultDB> {
    let head = build_rollup_head(config);
    let tail = build_rollup_tail(config);
    let branches = build_branch_nodes();

    let root = make_array(vec![head, tail, branches]);

    ContractState::new(
        root,
        build_bridge_operations(),
        ContractMaintenanceAuthority::new(),
    )
}

pub fn serialize_bridge_state_to_file(
    state: &ContractState<DefaultDB>,
    path: &Path,
) -> Result<()> {
    let mut buf = Vec::new();
    tagged_serialize(state, &mut buf)
        .map_err(|e| anyhow::anyhow!("tagged_serialize failed: {}", e))?;
    let mut file = std::fs::File::create(path)
        .with_context(|| format!("failed to create {}", path.display()))?;
    file.write_all(&buf)
        .with_context(|| format!("failed to write {}", path.display()))?;
    Ok(())
}

fn make_cell_u64(v: u64) -> SV {
    StateValue::Cell(Sp::new(AlignedValue::from(v)))
}

fn make_cell_u8(v: u8) -> SV {
    StateValue::Cell(Sp::new(AlignedValue::from(v)))
}

fn make_cell_u128(v: u128) -> SV {
    StateValue::Cell(Sp::new(AlignedValue::from(v)))
}

fn make_cell_bytes32(v: [u8; 32]) -> SV {
    StateValue::Cell(Sp::new(AlignedValue::from(v)))
}

fn make_array(items: Vec<SV>) -> SV {
    let mut arr = Array::<SV, DefaultDB>::new();
    for item in items {
        arr = arr.push(item);
    }
    StateValue::Array(arr)
}

/// Verifier set: 3 curve points, each with x and y coordinates (6 atoms total).
/// If `keys` is non-empty, uses the provided (x, y) pairs; otherwise all zeros.
fn make_verifier_set_cell(keys: &[([u8; 32], [u8; 32])]) -> SV {
    let zero32 = [0u8; 32];
    let get = |i: usize| -> ([u8; 32], [u8; 32]) {
        keys.get(i).copied().unwrap_or((zero32, zero32))
    };
    let (x0, y0) = get(0);
    let (x1, y1) = get(1);
    let (x2, y2) = get(2);
    StateValue::Cell(Sp::new(AlignedValue::from((x0, y0, x1, y1, x2, y2))))
}

/// Misc data cell: 5 atoms (lastCommittedBatchIndex, lastFinalizedBatchIndex,
/// lastFinalizeTimestamp, flags, reserved).
fn make_misc_data_cell(last_committed_batch_index: u64, last_finalized_batch_index: u64) -> SV {
    let reserved = [0u8; 11];
    StateValue::Cell(Sp::new(AlignedValue::from((
        last_committed_batch_index,  // lastCommittedBatchIndex
        last_finalized_batch_index,  // lastFinalizedBatchIndex
        0u64,                        // lastFinalizeTimestamp
        0u64,                        // flags
        reserved,
    ))))
}

/// Build a single deposit entry as a 6-field Array matching the layout
/// decoded by `decode_deposit` (Array variant with 6 cells).
fn make_deposit_entry(index: u64) -> SV {
    let mut sender = [0u8; 32];
    sender[0..8].copy_from_slice(&index.to_le_bytes());
    let recipient = [0xABu8; 32];
    let amount: u128 = 1_000_000 + index as u128;
    let nonce = index;
    let gas_limit: u64 = 100_000;
    let data_hash = [0u8; 32];

    make_array(vec![
        make_cell_bytes32(sender),
        make_cell_bytes32(recipient),
        make_cell_u128(amount),
        make_cell_u64(nonce),
        make_cell_u64(gas_limit),
        make_cell_bytes32(data_hash),
    ])
}

/// Build a Set<Bytes<32>> with `count` synthetic entries plus explicit extras.
/// `prefix` distinguishes different sets (sequencers vs finalizers vs executed messages).
fn build_bytes32_set(count: u64, prefix: u8, extras: &[[u8; 32]]) -> SV {
    let mut map: HashMap<AlignedValue, SV, DefaultDB> = HashMap::new();
    for i in 0..count {
        let mut key = [0u8; 32];
        key[0] = prefix;
        key[1..9].copy_from_slice(&i.to_le_bytes());
        map = map.insert(AlignedValue::from(key), make_cell_u8(0));
    }
    for extra in extras {
        map = map.insert(AlignedValue::from(*extra), make_cell_u8(0));
    }
    StateValue::Map(map)
}

/// Build a Map<Uint<64>, Bytes<32>> with `count` synthetic entries.
fn build_u64_bytes32_map(count: u64) -> SV {
    let mut map: HashMap<AlignedValue, SV, DefaultDB> = HashMap::new();
    for i in 0..count {
        let mut val = [0u8; 32];
        val[0..8].copy_from_slice(&i.to_le_bytes());
        map = map.insert(AlignedValue::from(i), make_cell_bytes32(val));
    }
    StateValue::Map(map)
}

/// Build withdrawRoots map: `count` synthetic entries plus explicit (batchIndex, root) pairs.
fn build_withdraw_roots_map(count: u64, specific: &[(u64, [u8; 32])]) -> SV {
    let mut map: HashMap<AlignedValue, SV, DefaultDB> = HashMap::new();
    for i in 0..count {
        let mut val = [0u8; 32];
        val[0..8].copy_from_slice(&i.to_le_bytes());
        map = map.insert(AlignedValue::from(i), make_cell_bytes32(val));
    }
    for &(idx, root) in specific {
        map = map.insert(AlignedValue::from(idx), make_cell_bytes32(root));
    }
    StateValue::Map(map)
}

/// Build a Map<Uint<64>, Uint<64>> with `count` entries.
fn build_u64_u64_map(count: u64) -> SV {
    let mut map: HashMap<AlignedValue, SV, DefaultDB> = HashMap::new();
    for i in 0..count {
        map = map.insert(AlignedValue::from(i), make_cell_u64(i));
    }
    StateValue::Map(map)
}

/// Build a Map<Bytes<32>, Uint<128>> with `count` synthetic pending withdrawal entries.
/// Each entry has key = synthetic recipient, value = 1_000_000 + i.
pub fn pending_withdrawal_recipient(i: u64) -> [u8; 32] {
    let mut key = [0u8; 32];
    key[0] = 0x04;
    key[1..9].copy_from_slice(&i.to_le_bytes());
    key
}

fn build_pending_withdrawals(count: u64) -> SV {
    let mut map: HashMap<AlignedValue, SV, DefaultDB> = HashMap::new();
    for i in 0..count {
        let key = pending_withdrawal_recipient(i);
        let amount: u128 = 1_000_000 + i as u128;
        map = map.insert(AlignedValue::from(key), make_cell_u128(amount));
    }
    StateValue::Map(map)
}

/// Build the l2GatewayBalances map from explicit (pubkey, balance) pairs.
fn build_l2_gateway_balances(balances: &[([u8; 32], u128)]) -> SV {
    let mut map: HashMap<AlignedValue, SV, DefaultDB> = HashMap::new();
    for (key, amount) in balances {
        map = map.insert(AlignedValue::from(*key), make_cell_u128(*amount));
    }
    StateValue::Map(map)
}

/// Build the operations map with entry points for all Bridge impure circuits.
/// Each operation has `None` as verifier key (sufficient for intent generation).
fn build_bridge_operations() -> HashMap<EntryPointBuf, ContractOperation, DefaultDB> {
    let circuit_names = [
        "withdrawNIGHT",
        "depositNIGHTUnshielded",
        "depositNIGHTUnshieldedWithFee",
        "relayWithdrawNIGHTWithProof",
        "claimL1WithdrawalUnshielded",
        "claimL1FeesUnshielded",
        "commitBatch",
        "finalizeBatch",
        "addSequencer",
        "removeSequencer",
        "addFinalizer",
        "removeFinalizer",
        "setVerifierSet",
    ];
    let mut ops: HashMap<EntryPointBuf, ContractOperation, DefaultDB> = HashMap::new();
    for name in circuit_names {
        ops = ops.insert(
            EntryPointBuf(name.as_bytes().to_vec()),
            ContractOperation::new(None),
        );
    }
    ops
}

/// Rollup head: Array[13] matching `decode_rollup_head` field order.
fn build_rollup_head(config: &BridgeStateConfig) -> SV {
    let last_finalized = 0u64;
    let last_committed = config.last_committed_batch_index.unwrap_or(last_finalized);

    make_array(vec![
        make_cell_bytes32(config.owner),                                                    // owner
        make_cell_u64(0),                                                                   // layer2ChainId
        make_cell_bytes32([0u8; 32]),                                                       // rollupId
        make_verifier_set_cell(&config.verifier_set),                                       // verifierSet
        make_cell_u8(config.signature_threshold),                                           // signatureThreshold
        build_bytes32_set(config.num_sequencers, 0x01, &config.extra_sequencers),              // sequencers
        build_bytes32_set(config.num_finalizers, 0x02, &config.extra_finalizers),             // finalizers
        make_cell_bytes32(config.last_committed_batch_hash),                                // lastCommittedBatchHash
        make_cell_bytes32(config.last_finalized_state_root),                                // lastFinalizedStateRoot
        make_cell_bytes32(config.last_finalized_batch_hash),                                // lastFinalizedBatchHash
        build_withdraw_roots_map(config.num_withdraw_roots, &config.specific_withdraw_roots), // withdrawRoots
        make_misc_data_cell(last_committed, last_finalized),                                // miscData
        make_cell_u64(0),                                                                   // firstCrossDomainMessageIndex
    ])
}

/// Rollup tail: Array[15] matching `decode_rollup_tail_and_modules` field order.
fn build_rollup_tail(config: &BridgeStateConfig) -> SV {
    let mut deposits_map: HashMap<AlignedValue, SV, DefaultDB> = HashMap::new();
    for i in 0..config.num_deposits {
        deposits_map = deposits_map.insert(AlignedValue::from(i), make_deposit_entry(i));
    }

    make_array(vec![
        make_cell_u64(config.num_deposits),                              // nextCrossDomainMessageIndex
        make_cell_u64(0),                                                // nextUnfinalizedQueueIndex
        build_u64_bytes32_map(config.num_message_hashes),                // messageRollingHashes
        build_u64_u64_map(config.num_message_hashes),                    // messageTimestamps
        StateValue::Map(deposits_map),                                   // l1ToL2Deposits
        build_bytes32_set(config.num_executed_messages, 0x03, &[]),      // executedL2ToL1Messages
        make_cell_u128(config.locked_night),                             // lockedNIGHT
        make_cell_u128(config.fee_vault),                                // feeVault
        build_pending_withdrawals(config.num_pending_withdrawals),       // pendingWithdrawals
        build_l2_gateway_balances(&config.l2_gateway_balances),          // l2GatewayBalances
        make_cell_u64(0),                                                // lastProcessedL1Index
        make_cell_bytes32([0u8; 32]),                                    // xDomainMessageSender
        make_cell_u64(0),                                                // messageCount
        make_cell_bytes32([0u8; 32]),                                    // withdrawRoot
        make_cell_bytes32([0u8; 32]),                                    // branch0
    ])
}

/// Branch nodes: Array[15] (branch1..branch15), all zero.
fn build_branch_nodes() -> SV {
    let nodes: Vec<SV> = (0..15).map(|_| make_cell_bytes32([0u8; 32])).collect();
    make_array(nodes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_bridge_state_with_zero_deposits() {
        let _state = build_bridge_state(&BridgeStateConfig::default());
    }

    #[test]
    fn build_bridge_state_with_100_deposits() {
        let config = BridgeStateConfig { num_deposits: 100, ..Default::default() };
        let _state = build_bridge_state(&config);
    }

    #[test]
    fn build_bridge_state_with_all_fields_populated() {
        let config = BridgeStateConfig {
            num_deposits: 10,
            num_sequencers: 5,
            num_finalizers: 3,
            num_withdraw_roots: 8,
            num_message_hashes: 10,
            num_executed_messages: 4,
            num_pending_withdrawals: 6,
            owner: [0xAA; 32],
            locked_night: 999_999,
            fee_vault: 500_000,
            last_finalized_batch_hash: [0xBB; 32],
            l2_gateway_balances: vec![([0xCC; 32], 1_000_000)],
            verifier_set: vec![([0x01; 32], [0x02; 32]), ([0x03; 32], [0x04; 32]), ([0x05; 32], [0x06; 32])],
            signature_threshold: 2,
            last_committed_batch_hash: [0xDD; 32],
            last_committed_batch_index: Some(1),
            specific_withdraw_roots: vec![(42, [0xEE; 32])],
            last_finalized_state_root: [0xFF; 32],
            extra_sequencers: vec![[0x99; 32]],
            extra_finalizers: vec![[0x88; 32]],
        };
        let _state = build_bridge_state(&config);
    }
}
