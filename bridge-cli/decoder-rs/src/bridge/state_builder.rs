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

pub struct BridgeStateConfig {
    pub num_deposits: u64,
}

/// Build a `ContractState<DefaultDB>` whose `l1ToL2Deposits` map
/// (at `root[1][4]`) contains `config.num_deposits` synthetic entries.
///
/// The state tree layout mirrors the Bridge contract as decoded by
/// `decode_bridge_ledger` in `commands/decode.rs`:
///
/// ```text
/// root = Array[3]
///   [0] = rollup_head  (Array[13])
///   [1] = rollup_tail  (Array[15])  -- index 4 is l1ToL2Deposits
///   [2] = branch_nodes (Array[15])
/// ```
pub fn build_bridge_state(config: &BridgeStateConfig) -> ContractState<DefaultDB> {
    let head = build_rollup_head();
    let tail = build_rollup_tail(config.num_deposits);
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

fn make_empty_map() -> SV {
    StateValue::Map(HashMap::new())
}

fn make_array(items: Vec<SV>) -> SV {
    let mut arr = Array::<SV, DefaultDB>::new();
    for item in items {
        arr = arr.push(item);
    }
    StateValue::Array(arr)
}

/// Verifier set: 3 curve points, each with x and y coordinates (6 atoms total).
/// All zeros for the synthetic state.
fn make_verifier_set_cell() -> SV {
    let zero32 = [0u8; 32];
    StateValue::Cell(Sp::new(AlignedValue::from((
        zero32, zero32, zero32, zero32, zero32, zero32,
    ))))
}

/// Misc data cell: 5 atoms (lastCommittedBatchIndex, lastFinalizedBatchIndex,
/// lastFinalizeTimestamp, flags, reserved).
fn make_misc_data_cell() -> SV {
    let reserved = [0u8; 11];
    StateValue::Cell(Sp::new(AlignedValue::from((
        0u64, 0u64, 0u64, 0u64, reserved,
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
fn build_rollup_head() -> SV {
    make_array(vec![
        make_cell_bytes32([0u8; 32]),          // owner
        make_cell_u64(0),                      // layer2ChainId
        make_cell_bytes32([0u8; 32]),          // rollupId
        make_verifier_set_cell(),              // verifierSet
        make_cell_u8(0),                       // signatureThreshold
        make_empty_map(),                      // sequencers
        make_empty_map(),                      // finalizers
        make_cell_bytes32([0u8; 32]),          // lastCommittedBatchHash
        make_cell_bytes32([0u8; 32]),          // lastFinalizedStateRoot
        make_cell_bytes32([0u8; 32]),          // lastFinalizedBatchHash
        make_empty_map(),                      // withdrawRoots
        make_misc_data_cell(),                 // miscData
        make_cell_u64(0),                      // firstCrossDomainMessageIndex
    ])
}

/// Rollup tail: Array[15] matching `decode_rollup_tail_and_modules` field order.
/// Index 4 (`l1ToL2Deposits`) is populated with `num_deposits` entries.
fn build_rollup_tail(num_deposits: u64) -> SV {
    let mut deposits_map: HashMap<AlignedValue, SV, DefaultDB> = HashMap::new();
    for i in 0..num_deposits {
        deposits_map = deposits_map.insert(AlignedValue::from(i), make_deposit_entry(i));
    }

    make_array(vec![
        make_cell_u64(num_deposits),           // nextCrossDomainMessageIndex
        make_cell_u64(0),                      // nextUnfinalizedQueueIndex
        make_empty_map(),                      // messageRollingHashes
        make_empty_map(),                      // messageTimestamps
        StateValue::Map(deposits_map),         // l1ToL2Deposits
        make_empty_map(),                      // executedL2ToL1Messages
        make_cell_u128(0),                     // lockedNIGHT
        make_cell_u128(0),                     // feeVault
        make_empty_map(),                      // pendingWithdrawals
        make_empty_map(),                      // l2GatewayBalances
        make_cell_u64(0),                      // lastProcessedL1Index
        make_cell_bytes32([0u8; 32]),          // xDomainMessageSender
        make_cell_u64(0),                      // messageCount
        make_cell_bytes32([0u8; 32]),          // withdrawRoot
        make_cell_bytes32([0u8; 32]),          // branch0
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
        let config = BridgeStateConfig { num_deposits: 0 };
        let _state = build_bridge_state(&config);
    }

    #[test]
    fn build_bridge_state_with_100_deposits() {
        let config = BridgeStateConfig { num_deposits: 100 };
        let _state = build_bridge_state(&config);
    }
}
