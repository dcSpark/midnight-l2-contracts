use std::collections::{BTreeMap, BTreeSet};
use std::convert::TryInto;
use std::fmt;
use std::io::Cursor;
use std::ops::Deref;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use base_crypto::fab::{AlignedValue, ValueAtom};
use clap::{ArgAction, Parser};
use hex::FromHex;
use midnight_onchain_state::state::{ChargedState, ContractMaintenanceAuthority, ContractState};
use midnight_serialize::{Deserializable, tagged_deserialize};
use midnight_storage::arena::{Sp, set_allow_non_normal_form_deserialization};
use midnight_storage::db::InMemoryDB;
use midnight_storage::storage::HashMap as StorageHashMap;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const DEFAULT_INDEXER_HTTP: &str = "http://127.0.0.1:8088/api/v3/graphql";
const DEFAULT_CONTRACT_ADDRESS: &str =
    "5318d3809209676484a89c55046062a723e3c5d0cb07e53547781119be8089ff";
const LEGACY_CONTRACT_STATE_TAG_V4: &[u8] = b"midnight:contract-state[v4]:";

#[derive(Parser, Debug)]
#[command(
    author,
    version,
    about = "Decode Bridge deposits via the Midnight indexer"
)]
struct Args {
    /// Bridge contract address (64 hex chars).
    #[arg(long, env = "BRIDGE_CONTRACT_ADDRESS", default_value = DEFAULT_CONTRACT_ADDRESS)]
    contract: String,

    /// GraphQL endpoint for the indexer HTTP API.
    #[arg(long, env = "INDEXER_HTTP", default_value = DEFAULT_INDEXER_HTTP)]
    indexer: String,

    /// Print the raw contract state as JSON for debugging.
    #[arg(long, action = ArgAction::SetTrue)]
    dump_state: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    // Preview indexer data currently ships legacy contract-state blobs that
    // violate the storage "normal form" constraint, so accept them.
    set_allow_non_normal_form_deserialization(true);

    validate_contract_address(&args.contract)?;

    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .context("failed to build HTTP client")?;

    let state_bytes = fetch_contract_state(&client, &args.indexer, &args.contract).await?;
    let contract_state = deserialize_contract_state(&state_bytes)?;
    let ledger = decode_bridge_ledger(&contract_state)?;

    if args.dump_state {
        dump_bridge_ledger(&ledger)?;
        return Ok(());
    }

    println!("Querying Bridge contract at address: {}", args.contract);
    println!("Indexer (HTTP): {}", args.indexer);
    println!("Owner: 0x{}", hex::encode(ledger.rollup.owner));
    println!("Layer2 chain ID: {}", ledger.rollup.layer2_chain_id);
    println!(
        "Next cross-domain message index: {}",
        ledger.rollup.next_cross_domain_message_index
    );

    let deposits = &ledger.rollup.l1_to_l2_deposits;
    if deposits.is_empty() {
        println!("No pending L1 -> L2 deposits recorded in the ledger.");
    } else {
        println!(
            "L1 -> L2 deposit map ({} entries):",
            deposits.len()
        );
        for (idx, deposit) in deposits {
            println!("  Key {}: {}", idx, deposit);
        }
    }

    Ok(())
}

fn validate_contract_address(address: &str) -> Result<()> {
    if address.len() != 64 || !address.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(anyhow!("contract address must be 64 lowercase hex chars"));
    }
    Ok(())
}

fn dump_bridge_ledger(ledger: &BridgeLedger) -> Result<()> {
    let json_value = serde_json::to_value(ledger).context("failed to serialize bridge ledger")?;
    let normalized = convert_byte_arrays(json_value);
    let mut buffer = String::new();
    format_json_with_inline_arrays(&normalized, 0, &mut buffer)?;
    println!("Parsed ledger:\n{}", buffer);
    Ok(())
}

fn format_json_with_inline_arrays(value: &Value, indent: usize, out: &mut String) -> Result<()> {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {
            let rendered = serde_json::to_string(value)
                .context("failed to render scalar json value")?;
            out.push_str(&rendered);
        }
        Value::Array(items) => {
            out.push('[');
            for (idx, item) in items.iter().enumerate() {
                if idx > 0 {
                    out.push_str(", ");
                }
                format_json_with_inline_arrays(item, indent, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return Ok(());
            }
            out.push_str("{\n");
            for (idx, (key, item)) in map.iter().enumerate() {
                write_indent(indent + 2, out);
                let rendered_key = serde_json::to_string(key)
                    .context("failed to render json key")?;
                out.push_str(&rendered_key);
                out.push_str(": ");
                format_json_with_inline_arrays(item, indent + 2, out)?;
                if idx + 1 != map.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            write_indent(indent, out);
            out.push('}');
        }
    }
    Ok(())
}

fn write_indent(level: usize, out: &mut String) {
    for _ in 0..level {
        out.push(' ');
    }
}

fn convert_byte_arrays(value: Value) -> Value {
    match value {
        Value::Array(items) => {
            if is_byte_array(&items) {
                let bytes: Vec<u8> = items
                    .into_iter()
                    .map(|item| item.as_u64().unwrap() as u8)
                    .collect();
                Value::String(hex::encode(bytes))
            } else {
                Value::Array(items.into_iter().map(convert_byte_arrays).collect())
            }
        }
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, val)| (key, convert_byte_arrays(val)))
                .collect(),
        ),
        other => other,
    }
}

fn is_byte_array(items: &[Value]) -> bool {
    !items.is_empty()
        && items.iter().all(|item| match item {
            Value::Number(num) => num
                .as_u64()
                .map(|val| val <= u8::MAX as u64)
                .unwrap_or(false),
            _ => false,
        })
}

#[derive(Debug, Serialize)]
struct BridgeLedger {
    rollup: RollupLedger,
    l2_gateway: L2GatewayLedger,
    l2_messenger: L2MessengerLedger,
    l2_message_queue: L2MessageQueueLedger,
}

#[derive(Debug, Serialize)]
struct RollupLedger {
    owner: [u8; 32],
    layer2_chain_id: u64,
    rollup_id: [u8; 32],
    verifier_set: [CurvePoint; 3],
    signature_threshold: u8,
    sequencers: BTreeSet<[u8; 32]>,
    finalizers: BTreeSet<[u8; 32]>,
    committed_batches: BTreeMap<u64, [u8; 32]>,
    finalized_state_roots: BTreeMap<u64, [u8; 32]>,
    withdraw_roots: BTreeMap<u64, [u8; 32]>,
    misc_data: RollupMiscData,
    first_cross_domain_message_index: u64,
    next_cross_domain_message_index: u64,
    next_unfinalized_queue_index: u64,
    message_rolling_hashes: BTreeMap<u64, [u8; 32]>,
    message_timestamps: BTreeMap<u64, u64>,
    l1_to_l2_deposits: BTreeMap<u64, Deposit>,
    executed_l2_to_l1_messages: BTreeSet<[u8; 32]>,
    locked_night: u128,
    fee_vault: u128,
    pending_withdrawals: BTreeMap<[u8; 32], u128>,
}

#[derive(Clone, Debug, Serialize)]
struct RollupMiscData {
    last_committed_batch_index: u64,
    last_finalized_batch_index: u64,
    last_finalize_timestamp: u64,
    flags: u8,
    reserved: [u8; 11],
}

#[derive(Clone, Debug, Serialize)]
struct CurvePoint {
    x: [u8; 32],
    y: [u8; 32],
}

#[derive(Debug, Serialize)]
struct L2GatewayLedger {
    balances: BTreeMap<[u8; 32], u128>,
}

#[derive(Debug, Serialize)]
struct L2MessengerLedger {
    last_processed_l1_index: u64,
    x_domain_message_sender: [u8; 32],
}

#[derive(Debug, Serialize)]
struct L2MessageQueueLedger {
    message_count: u64,
    withdraw_root: [u8; 32],
    branches: Vec<[u8; 32]>,
}

#[derive(Clone, Debug, Serialize)]
struct Deposit {
    sender: [u8; 32],
    recipient: [u8; 32],
    amount: u128,
    nonce: u64,
    gas_limit: u64,
    data_hash: [u8; 32],
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

struct RollupHead {
    owner: [u8; 32],
    layer2_chain_id: u64,
    rollup_id: [u8; 32],
    verifier_set: [CurvePoint; 3],
    signature_threshold: u8,
    sequencers: BTreeSet<[u8; 32]>,
    finalizers: BTreeSet<[u8; 32]>,
    committed_batches: BTreeMap<u64, [u8; 32]>,
    finalized_state_roots: BTreeMap<u64, [u8; 32]>,
    withdraw_roots: BTreeMap<u64, [u8; 32]>,
    misc_data: RollupMiscData,
    first_cross_domain_message_index: u64,
}

struct RollupTail {
    next_cross_domain_message_index: u64,
    next_unfinalized_queue_index: u64,
    message_rolling_hashes: BTreeMap<u64, [u8; 32]>,
    message_timestamps: BTreeMap<u64, u64>,
    l1_to_l2_deposits: BTreeMap<u64, Deposit>,
    executed_l2_to_l1_messages: BTreeSet<[u8; 32]>,
    locked_night: u128,
    fee_vault: u128,
    pending_withdrawals: BTreeMap<[u8; 32], u128>,
}

fn decode_bridge_ledger(state: &ContractState<InMemoryDB>) -> Result<BridgeLedger> {
    let root = state.data.get_ref();
    let root_parts = expect_array(root).context("bridge state root must be an array")?;
    if root_parts.len() != 3 {
        return Err(anyhow!(
            "expected 3 top-level state segments, found {}",
            root_parts.len()
        ));
    }

    let rollup_head = decode_rollup_head(root_parts[0].deref())?;
    let (rollup_tail, l2_gateway, l2_messenger, l2_message_queue) =
        decode_rollup_tail_and_modules(root_parts[1].deref(), root_parts[2].deref())?;

    let rollup = RollupLedger {
        owner: rollup_head.owner,
        layer2_chain_id: rollup_head.layer2_chain_id,
        rollup_id: rollup_head.rollup_id,
        verifier_set: rollup_head.verifier_set,
        signature_threshold: rollup_head.signature_threshold,
        sequencers: rollup_head.sequencers,
        finalizers: rollup_head.finalizers,
        committed_batches: rollup_head.committed_batches,
        finalized_state_roots: rollup_head.finalized_state_roots,
        withdraw_roots: rollup_head.withdraw_roots,
        misc_data: rollup_head.misc_data,
        first_cross_domain_message_index: rollup_head.first_cross_domain_message_index,
        next_cross_domain_message_index: rollup_tail.next_cross_domain_message_index,
        next_unfinalized_queue_index: rollup_tail.next_unfinalized_queue_index,
        message_rolling_hashes: rollup_tail.message_rolling_hashes,
        message_timestamps: rollup_tail.message_timestamps,
        l1_to_l2_deposits: rollup_tail.l1_to_l2_deposits,
        executed_l2_to_l1_messages: rollup_tail.executed_l2_to_l1_messages,
        locked_night: rollup_tail.locked_night,
        fee_vault: rollup_tail.fee_vault,
        pending_withdrawals: rollup_tail.pending_withdrawals,
    };

    Ok(BridgeLedger {
        rollup,
        l2_gateway,
        l2_messenger,
        l2_message_queue,
    })
}

fn decode_rollup_head(value: &StateValue) -> Result<RollupHead> {
    let items = expect_array(value).context("rollup header must be an array")?;
    if items.len() != 12 {
        return Err(anyhow!(
            "rollup header expected 12 entries, found {}",
            items.len()
        ));
    }
    let mut iter = items.into_iter();

    let owner = decode_bytes32_value(iter_next(&mut iter, "owner")?.deref(), "owner")?;
    let layer2_chain_id = decode_u64_value(
        iter_next(&mut iter, "layer2ChainId")?.deref(),
        "layer2ChainId",
    )?;
    let rollup_id = decode_bytes32_value(iter_next(&mut iter, "rollupId")?.deref(), "rollupId")?;
    let verifier_set = decode_curve_point_vector(
        iter_next(&mut iter, "verifierSet")?.deref(),
        "verifierSet",
    )?;
    let signature_threshold = decode_u8_value(
        iter_next(&mut iter, "signatureThreshold")?.deref(),
        "signatureThreshold",
    )?;
    let sequencers = decode_bytes32_set(
        iter_next(&mut iter, "sequencers")?.deref(),
        "sequencers",
    )?;
    let finalizers = decode_bytes32_set(
        iter_next(&mut iter, "finalizers")?.deref(),
        "finalizers",
    )?;
    let committed_batches = decode_u64_bytes32_map(
        iter_next(&mut iter, "committedBatches")?.deref(),
        "committedBatches",
    )?;
    let finalized_state_roots = decode_u64_bytes32_map(
        iter_next(&mut iter, "finalizedStateRoots")?.deref(),
        "finalizedStateRoots",
    )?;
    let withdraw_roots = decode_u64_bytes32_map(
        iter_next(&mut iter, "withdrawRoots")?.deref(),
        "withdrawRoots",
    )?;
    let misc_data = decode_misc_data(
        iter_next(&mut iter, "miscData")?.deref(),
        "miscData",
    )?;
    let first_cross_domain_message_index = decode_u64_value(
        iter_next(&mut iter, "firstCrossDomainMessageIndex")?.deref(),
        "firstCrossDomainMessageIndex",
    )?;

    if iter.next().is_some() {
        return Err(anyhow!("unexpected extra entries in rollup header"));
    }

    Ok(RollupHead {
        owner,
        layer2_chain_id,
        rollup_id,
        verifier_set,
        signature_threshold,
        sequencers,
        finalizers,
        committed_batches,
        finalized_state_roots,
        withdraw_roots,
        misc_data,
        first_cross_domain_message_index,
    })
}

fn decode_rollup_tail_and_modules(
    value: &StateValue,
    branch_nodes: &StateValue,
) -> Result<(RollupTail, L2GatewayLedger, L2MessengerLedger, L2MessageQueueLedger)> {
    let items = expect_array(value).context("rollup tail must be an array")?;
    if items.len() != 15 {
        return Err(anyhow!(
            "rollup tail expected 15 entries, found {}",
            items.len()
        ));
    }
    let mut iter = items.into_iter();

    let next_cross_domain_message_index = decode_u64_value(
        iter_next(&mut iter, "nextCrossDomainMessageIndex")?.deref(),
        "nextCrossDomainMessageIndex",
    )?;
    let next_unfinalized_queue_index = decode_u64_value(
        iter_next(&mut iter, "nextUnfinalizedQueueIndex")?.deref(),
        "nextUnfinalizedQueueIndex",
    )?;
    let message_rolling_hashes = decode_u64_bytes32_map(
        iter_next(&mut iter, "messageRollingHashes")?.deref(),
        "messageRollingHashes",
    )?;
    let message_timestamps = decode_u64_u64_map(
        iter_next(&mut iter, "messageTimestamps")?.deref(),
        "messageTimestamps",
    )?;
    let l1_to_l2_deposits = decode_deposit_map(
        iter_next(&mut iter, "l1ToL2Deposits")?.deref(),
        "l1ToL2Deposits",
    )?;
    let executed_l2_to_l1_messages = decode_bytes32_set(
        iter_next(&mut iter, "executedL2ToL1Messages")?.deref(),
        "executedL2ToL1Messages",
    )?;
    let locked_night = decode_u128_value(
        iter_next(&mut iter, "lockedNIGHT")?.deref(),
        "lockedNIGHT",
    )?;
    let fee_vault = decode_u128_value(
        iter_next(&mut iter, "feeVault")?.deref(),
        "feeVault",
    )?;
    let pending_withdrawals = decode_bytes32_u128_map(
        iter_next(&mut iter, "pendingWithdrawals")?.deref(),
        "pendingWithdrawals",
    )?;
    let l2_balances = decode_bytes32_u128_map(
        iter_next(&mut iter, "l2GatewayBalances")?.deref(),
        "l2GatewayBalances",
    )?;
    let last_processed_l1_index = decode_u64_value(
        iter_next(&mut iter, "lastProcessedL1Index")?.deref(),
        "lastProcessedL1Index",
    )?;
    let x_domain_message_sender = decode_bytes32_value(
        iter_next(&mut iter, "xDomainMessageSender")?.deref(),
        "xDomainMessageSender",
    )?;
    let message_count = decode_u64_value(
        iter_next(&mut iter, "messageCount")?.deref(),
        "messageCount",
    )?;
    let withdraw_root = decode_bytes32_value(
        iter_next(&mut iter, "withdrawRoot")?.deref(),
        "withdrawRoot",
    )?;
    let branch0 = decode_bytes32_value(
        iter_next(&mut iter, "branch0")?.deref(),
        "branch0",
    )?;

    if iter.next().is_some() {
        return Err(anyhow!("unexpected extra entries in rollup tail"));
    }

    let branches = decode_branch_nodes(branch_nodes, branch0)?;

    let rollup_tail = RollupTail {
        next_cross_domain_message_index,
        next_unfinalized_queue_index,
        message_rolling_hashes,
        message_timestamps,
        l1_to_l2_deposits,
        executed_l2_to_l1_messages,
        locked_night,
        fee_vault,
        pending_withdrawals,
    };

    let l2_gateway = L2GatewayLedger { balances: l2_balances };
    let l2_messenger = L2MessengerLedger {
        last_processed_l1_index,
        x_domain_message_sender,
    };
    let l2_message_queue = L2MessageQueueLedger {
        message_count,
        withdraw_root,
        branches,
    };

    Ok((rollup_tail, l2_gateway, l2_messenger, l2_message_queue))
}

fn decode_branch_nodes(value: &StateValue, branch0: [u8; 32]) -> Result<Vec<[u8; 32]>> {
    let entries = expect_array(value).context("message queue branches must be an array")?;
    if entries.len() != 15 {
        return Err(anyhow!(
            "expected 15 additional branch nodes, found {}",
            entries.len()
        ));
    }
    let mut branches = Vec::with_capacity(16);
    branches.push(branch0);
    for (idx, entry) in entries.into_iter().enumerate() {
        let node = decode_bytes32_value(
            entry.deref(),
            &format!("branch{}", idx + 1),
        )?;
        branches.push(node);
    }
    Ok(branches)
}

fn decode_deposit_map(value: &StateValue, label: &str) -> Result<BTreeMap<u64, Deposit>> {
    let StateValue::Map(map) = value else {
        return Err(anyhow!("{} must be a map", label));
    };
    let mut result = BTreeMap::new();
    for pair in map.iter() {
        let (key_sp, value_sp) = pair.deref();
        let idx = decode_u64(key_sp.deref()).context("failed to decode deposit key")?;
        if let Some(deposit) = decode_deposit(value_sp.deref())? {
            result.insert(idx, deposit);
        }
    }
    Ok(result)
}

fn decode_u64_bytes32_map(value: &StateValue, label: &str) -> Result<BTreeMap<u64, [u8; 32]>> {
    let StateValue::Map(map) = value else {
        return Err(anyhow!("{} must be a map", label));
    };
    let mut result = BTreeMap::new();
    for entry in map.iter() {
        let (key_sp, value_sp) = entry.deref();
        let key = decode_u64(key_sp.deref()).context("failed to decode u64 key")?;
        let val = decode_bytes32_value(value_sp.deref(), label)?;
        result.insert(key, val);
    }
    Ok(result)
}

fn decode_u64_u64_map(value: &StateValue, label: &str) -> Result<BTreeMap<u64, u64>> {
    let StateValue::Map(map) = value else {
        return Err(anyhow!("{} must be a map", label));
    };
    let mut result = BTreeMap::new();
    for entry in map.iter() {
        let (key_sp, value_sp) = entry.deref();
        let key = decode_u64(key_sp.deref()).context("failed to decode u64 key")?;
        let val = decode_u64_value(value_sp.deref(), label)?;
        result.insert(key, val);
    }
    Ok(result)
}

fn decode_bytes32_u128_map(value: &StateValue, label: &str) -> Result<BTreeMap<[u8; 32], u128>> {
    let StateValue::Map(map) = value else {
        return Err(anyhow!("{} must be a map", label));
    };
    let mut result = BTreeMap::new();
    for entry in map.iter() {
        let (key_sp, value_sp) = entry.deref();
        let key = decode_bytes32_from_aligned(key_sp.deref(), label)?;
        let val = decode_u128_value(value_sp.deref(), label)?;
        result.insert(key, val);
    }
    Ok(result)
}

fn decode_bytes32_set(value: &StateValue, label: &str) -> Result<BTreeSet<[u8; 32]>> {
    let StateValue::Map(map) = value else {
        return Err(anyhow!("{} must be a set map", label));
    };
    let mut result = BTreeSet::new();
    for entry in map.iter() {
        let (key_sp, _) = entry.deref();
        let key = decode_bytes32_from_aligned(key_sp.deref(), label)?;
        result.insert(key);
    }
    Ok(result)
}

fn decode_curve_point_vector(value: &StateValue, label: &str) -> Result<[CurvePoint; 3]> {
    let cell = expect_cell(value)?;
    if cell.value.0.len() != 6 {
        return Err(anyhow!("{} must contain 3 curve points", label));
    }
    let mut atoms = cell.value.0.iter();
    let mut points = Vec::with_capacity(3);
    while let Some(x_atom) = atoms.next() {
        let y_atom = atoms
            .next()
            .ok_or_else(|| anyhow!("{} missing y coordinate", label))?;
        let x = decode_field_atom(x_atom, label)?;
        let y = decode_field_atom(y_atom, label)?;
        points.push(CurvePoint { x, y });
    }
    points
        .try_into()
        .map_err(|_| anyhow!("{} expected 3 points", label))
}

fn decode_field_atom(atom: &ValueAtom, label: &str) -> Result<[u8; 32]> {
    decode_bytes_atom::<32>(atom, label)
}

fn decode_misc_data(value: &StateValue, label: &str) -> Result<RollupMiscData> {
    let cell = expect_cell(value)?;
    if cell.value.0.len() != 5 {
        return Err(anyhow!("{} must contain 5 atoms", label));
    }
    let mut atoms = cell.value.0.iter();
    let last_committed_batch_index = decode_u64_atom(
        atoms.next().ok_or_else(|| anyhow!("missing last committed"))?,
        "lastCommittedBatchIndex",
    )?;
    let last_finalized_batch_index = decode_u64_atom(
        atoms
            .next()
            .ok_or_else(|| anyhow!("missing last finalized"))?,
        "lastFinalizedBatchIndex",
    )?;
    let last_finalize_timestamp = decode_u64_atom(
        atoms
            .next()
            .ok_or_else(|| anyhow!("missing last finalize timestamp"))?,
        "lastFinalizeTimestamp",
    )?;
    let flags_raw = decode_u64_atom(
        atoms
            .next()
            .ok_or_else(|| anyhow!("missing flags"))?,
        "flags",
    )?;
    if flags_raw > u8::MAX as u64 {
        return Err(anyhow!("flags field exceeds u8 range"));
    }
    let flags = flags_raw as u8;
    let reserved = decode_bytes_atom::<11>(
        atoms
            .next()
            .ok_or_else(|| anyhow!("missing reserved bytes"))?,
        "reserved",
    )?;

    Ok(RollupMiscData {
        last_committed_batch_index,
        last_finalized_batch_index,
        last_finalize_timestamp,
        flags,
        reserved,
    })
}

fn decode_bytes32_value(value: &StateValue, label: &str) -> Result<[u8; 32]> {
    extract_bytes32(value).with_context(|| format!("failed to decode {} as bytes32", label))
}

fn decode_bytes32_from_aligned(aligned: &AlignedValue, label: &str) -> Result<[u8; 32]> {
    let slice = aligned.as_slice();
    let bytes =
        Vec::<u8>::try_from(&*slice).map_err(|_| anyhow!("failed to decode {} key", label))?;
    if bytes.len() > 32 {
        return Err(anyhow!("{} key exceeded 32 bytes", label));
    }
    let mut out = [0u8; 32];
    out[..bytes.len()].copy_from_slice(&bytes);
    Ok(out)
}

fn decode_u64_value(value: &StateValue, label: &str) -> Result<u64> {
    extract_cell_u64(value).with_context(|| format!("failed to decode {} as u64", label))
}

fn decode_u8_value(value: &StateValue, label: &str) -> Result<u8> {
    let raw = decode_u64_value(value, label)?;
    if raw > u8::MAX as u64 {
        return Err(anyhow!("{} exceeded u8 range", label));
    }
    Ok(raw as u8)
}

fn decode_u128_value(value: &StateValue, label: &str) -> Result<u128> {
    extract_cell_u128(value).with_context(|| format!("failed to decode {} as u128", label))
}

fn expect_array(value: &StateValue) -> Result<Vec<Sp<StateValue>>> {
    if let StateValue::Array(arr) = value {
        Ok(arr.iter().map(|node| node.clone()).collect())
    } else {
        Err(anyhow!("expected array state value"))
    }
}

fn iter_next<I>(iter: &mut I, label: &str) -> Result<Sp<StateValue>>
where
    I: Iterator<Item = Sp<StateValue>>,
{
    iter.next()
        .ok_or_else(|| anyhow!("{} missing from state array", label))
}

fn decode_deposit(value: &StateValue) -> Result<Option<Deposit>> {
    match value {
        StateValue::Array(fields) if fields.len() == 6 => {
            let mut elems = fields.iter();
            let sender = extract_bytes32(
                elems
                    .next()
                    .ok_or_else(|| anyhow!("deposit missing sender"))?
                    .deref(),
            )?;
            let recipient = extract_bytes32(
                elems
                    .next()
                    .ok_or_else(|| anyhow!("deposit missing recipient"))?
                    .deref(),
            )?;
            let amount = extract_cell_u128(
                elems
                    .next()
                    .ok_or_else(|| anyhow!("deposit missing amount"))?
                    .deref(),
            )?;
            let nonce = extract_cell_u64(
                elems
                    .next()
                    .ok_or_else(|| anyhow!("deposit missing nonce"))?
                    .deref(),
            )?;
            let gas_limit = extract_cell_u64(
                elems
                    .next()
                    .ok_or_else(|| anyhow!("deposit missing gas limit"))?
                    .deref(),
            )?;
            let data_hash = extract_bytes32(
                elems
                    .next()
                    .ok_or_else(|| anyhow!("deposit missing data hash"))?
                    .deref(),
            )?;
            Ok(Some(Deposit {
                sender,
                recipient,
                amount,
                nonce,
                gas_limit,
                data_hash,
            }))
        }
        StateValue::Cell(cell) => decode_deposit_cell(cell.deref()),
        StateValue::Null => Ok(None),
        _ => Ok(None),
    }
}
fn decode_deposit_cell(cell: &AlignedValue) -> Result<Option<Deposit>> {
    const EXPECTED_FIELDS: usize = 6;
    if cell.value.0.len() != EXPECTED_FIELDS {
        return Ok(None);
    }
    let mut atoms = cell.value.0.iter();
    let sender = decode_bytes_atom::<32>(atoms.next().unwrap(), "sender")?;
    let recipient = decode_bytes_atom::<32>(atoms.next().unwrap(), "recipient")?;
    let amount = decode_u128_atom(atoms.next().unwrap(), "amount")?;
    let nonce = decode_u64_atom(atoms.next().unwrap(), "nonce")?;
    let gas_limit = decode_u64_atom(atoms.next().unwrap(), "gas limit")?;
    let data_hash = decode_bytes_atom::<32>(atoms.next().unwrap(), "data hash")?;
    Ok(Some(Deposit {
        sender,
        recipient,
        amount,
        nonce,
        gas_limit,
        data_hash,
    }))
}

fn decode_bytes_atom<const N: usize>(atom: &ValueAtom, label: &str) -> Result<[u8; N]> {
    if atom.0.len() > N {
        return Err(anyhow!("{} field exceeded {} bytes", label, N));
    }
    let mut out = [0u8; N];
    out[..atom.0.len()].copy_from_slice(&atom.0);
    Ok(out)
}

fn decode_u64_atom(atom: &ValueAtom, label: &str) -> Result<u64> {
    u64::try_from(atom).map_err(|err| anyhow!("failed to decode {}: {}", label, err))
}

fn decode_u128_atom(atom: &ValueAtom, label: &str) -> Result<u128> {
    u128::try_from(atom).map_err(|err| anyhow!("failed to decode {}: {}", label, err))
}

fn extract_bytes32(value: &StateValue) -> Result<[u8; 32]> {
    let aligned = expect_cell(value)?;
    let slice = aligned.as_slice();
    let bytes =
        Vec::<u8>::try_from(&*slice).map_err(|_| anyhow!("failed to decode bytes field"))?;
    if bytes.len() > 32 {
        return Err(anyhow!("bytes32 field exceeded length"));
    }
    let mut out = [0u8; 32];
    out[..bytes.len()].copy_from_slice(&bytes);
    Ok(out)
}

fn extract_cell_u64(value: &StateValue) -> Result<u64> {
    let aligned = expect_cell(value)?;
    decode_u64(aligned)
}

fn extract_cell_u128(value: &StateValue) -> Result<u128> {
    let aligned = expect_cell(value)?;
    decode_u128(aligned)
}

fn expect_cell<'a>(value: &'a StateValue) -> Result<&'a AlignedValue> {
    if let StateValue::Cell(cell) = value {
        Ok(cell)
    } else {
        Err(anyhow!("expected cell state value"))
    }
}

fn decode_u64(aligned: &AlignedValue) -> Result<u64> {
    let slice = aligned.as_slice();
    u64::try_from(&*slice).map_err(|_| anyhow!("failed to decode u64"))
}

fn decode_u128(aligned: &AlignedValue) -> Result<u128> {
    let slice = aligned.as_slice();
    u128::try_from(&*slice).map_err(|_| anyhow!("failed to decode u128"))
}

async fn fetch_contract_state(client: &Client, indexer: &str, address: &str) -> Result<Vec<u8>> {
    let body = json!({
        "query": CONTRACT_STATE_QUERY,
        "variables": {
            "address": address,
            "offset": null,
        }
    });

    let resp = client
        .post(indexer)
        .json(&body)
        .send()
        .await
        .context("GraphQL request failed")?;

    if !resp.status().is_success() {
        return Err(anyhow!(
            "indexer request failed with status {}",
            resp.status()
        ));
    }

    let payload: GraphQlResponse<ContractActionWrapper> = resp.json().await?;
    if let Some(errors) = payload.errors {
        let joined = errors
            .into_iter()
            .map(|e| e.message)
            .collect::<Vec<_>>()
            .join(", ");
        return Err(anyhow!("GraphQL error: {}", joined));
    }
    let state_hex = payload
        .data
        .and_then(|wrapper| wrapper.contract_action)
        .map(|action| action.state)
        .ok_or_else(|| anyhow!("indexer returned empty contract state"))?;

    let bytes = Vec::from_hex(state_hex)
        .map_err(|err| anyhow!("failed to decode contract state hex: {}", err))?;
    Ok(bytes)
}

fn deserialize_contract_state(bytes: &[u8]) -> Result<ContractState<InMemoryDB>> {
    match tagged_deserialize(bytes) {
        Ok(state) => Ok(state),
        Err(primary_err) => match deserialize_contract_state_v4(bytes) {
            Ok(Some(legacy)) => Ok(legacy),
            Ok(None) => Err(anyhow!(
                "failed to deserialize ContractState: {}",
                primary_err
            )),
            Err(legacy_err) => Err(anyhow!(
                "failed to deserialize ContractState: {}; legacy decode error: {}",
                primary_err,
                legacy_err
            )),
        },
    }
}

fn deserialize_contract_state_v4(bytes: &[u8]) -> Result<Option<ContractState<InMemoryDB>>> {
    if !bytes.starts_with(LEGACY_CONTRACT_STATE_TAG_V4) {
        return Ok(None);
    }

    let mut reader = Cursor::new(&bytes[LEGACY_CONTRACT_STATE_TAG_V4.len()..]);
    let legacy_value = <StateValue as Deserializable>::deserialize(&mut reader, 0)
        .map_err(|err| anyhow!("legacy contract-state data decode failed: {}", err))?;
    let data = ChargedState::new(legacy_value);

    Ok(Some(ContractState {
        data,
        operations: StorageHashMap::new(),
        maintenance_authority: ContractMaintenanceAuthority::new(),
        balance: StorageHashMap::new(),
    }))
}

#[derive(Deserialize)]
struct GraphQlResponse<T> {
    data: Option<T>,
    errors: Option<Vec<GraphQlError>>,
}

#[derive(Deserialize)]
struct GraphQlError {
    message: String,
}

#[derive(Deserialize)]
struct ContractActionWrapper {
    #[serde(rename = "contractAction")]
    contract_action: Option<ContractActionState>,
}

#[derive(Deserialize)]
struct ContractActionState {
    state: String,
}

const CONTRACT_STATE_QUERY: &str = r#"
query CONTRACT_STATE_QUERY($address: HexEncoded!, $offset: ContractActionOffset) {
  contractAction(address: $address, offset: $offset) {
    state
  }
}
"#;

type StateValue = midnight_onchain_state::state::StateValue<InMemoryDB>;
