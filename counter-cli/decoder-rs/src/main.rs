use std::collections::BTreeMap;
use std::fmt;
use std::io::Cursor;
use std::ops::Deref;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use base_crypto::fab::{AlignedValue, ValueAtom};
use clap::{ArgAction, Parser};
use hex::FromHex;
use midnight_onchain_state::state::{ChargedState, ContractMaintenanceAuthority, ContractState};
use midnight_serialize::{Deserializable, tagged_deserialize};
use midnight_storage::arena::{Sp, set_allow_non_normal_form_deserialization};
use midnight_storage::db::InMemoryDB;
use midnight_storage::storage::HashMap as StorageHashMap;
use reqwest::Client;
use serde::Deserialize;
use serde_json::json;

const DEFAULT_INDEXER_HTTP: &str = "https://indexer.preview.midnight.network/api/v3/graphql";
const DEFAULT_CONTRACT_ADDRESS: &str =
    "fa8533250190a9d2b39686523e7b13e7dc30647a341f8163dceaec2cdc365f12";
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

    /// Specific deposit keys to print. Accepts repeated flags or comma-separated values.
    #[arg(
        long,
        env = "DEPOSIT_KEYS",
        value_delimiter = ',',
        default_values = ["0", "1", "2"]
    )]
    keys: Vec<u64>,

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

    if args.dump_state {
        dump_state(&contract_state)?;
        return Ok(());
    }

    let bridge_state = analyze_bridge_state(&contract_state)?;

    println!("Querying Bridge contract at address: {}", args.contract);
    println!("Indexer (HTTP): {}", args.indexer);
    println!(
        "Next cross-domain message index: {}",
        bridge_state.next_cross_domain_message_index
    );

    let mut cache = BTreeMap::new();
    for key in &args.keys {
        if let Some(deposit) = bridge_state.deposits.get(key).cloned() {
            cache.insert(*key, deposit);
        } else {
            eprintln!("warning: no deposit found for key {}", key);
        }
    }

    for key in &args.keys {
        if let Some(deposit) = cache.get(key) {
            println!("---");
            println!("Key {}", key);
            println!("{}", deposit);
        }
    }

    println!("---");
    println!(
        "Iterating over all deposits (0 → {}):",
        bridge_state
            .next_cross_domain_message_index
            .saturating_sub(1)
    );
    let mut printed = 0;
    for key in 0..bridge_state.next_cross_domain_message_index {
        if let Some(deposit) = bridge_state.deposits.get(&key) {
            println!("Key {}: {}", key, deposit);
            printed += 1;
        }
    }
    if printed == 0 {
        println!("Map is empty");
    } else {
        println!(
            "Displayed {} entries (up to index {}).",
            printed,
            bridge_state
                .next_cross_domain_message_index
                .saturating_sub(1)
        );
    }

    Ok(())
}

fn validate_contract_address(address: &str) -> Result<()> {
    if address.len() != 64 || !address.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(anyhow!("contract address must be 64 lowercase hex chars"));
    }
    Ok(())
}

fn dump_state(state: &ContractState<InMemoryDB>) -> Result<()> {
    println!("{:#?}", state.data.get_ref());
    Ok(())
}

#[derive(Debug)]
struct BridgeState {
    next_cross_domain_message_index: u64,
    deposits: BTreeMap<u64, Deposit>,
}

#[derive(Clone, Debug)]
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

fn analyze_bridge_state(state: &ContractState<InMemoryDB>) -> Result<BridgeState> {
    let root = state.data.get_ref();
    let deposit_node = locate_deposit_map(root)
        .ok_or_else(|| anyhow!("failed to locate deposit map in contract state"))?;
    let deposits = extract_deposits(deposit_node.as_ref())?;
    let next_cross = deposits
        .keys()
        .next_back()
        .map(|last| last.saturating_add(1))
        .unwrap_or(0);
    Ok(BridgeState {
        next_cross_domain_message_index: next_cross,
        deposits,
    })
}

fn locate_deposit_map<'a>(root: &'a StateValue) -> Option<StateNode<'a>> {
    locate_with_policy(root, false).or_else(|| locate_with_policy(root, true))
}

fn locate_with_policy<'a>(root: &'a StateValue, allow_empty: bool) -> Option<StateNode<'a>> {
    fn helper<'a>(node: StateNode<'a>, allow_empty: bool) -> Option<StateNode<'a>> {
        if is_deposit_map(node.as_ref(), allow_empty) {
            return Some(node);
        }
        match node.as_ref() {
            StateValue::Map(map) => {
                for entry in map.iter() {
                    let (_, child) = entry.deref();
                    if let Some(found) = helper(StateNode::Owned(child.clone()), allow_empty) {
                        return Some(found);
                    }
                }
            }
            StateValue::Array(arr) => {
                for elem in arr.iter() {
                    if let Some(found) = helper(StateNode::Owned(elem.clone()), allow_empty) {
                        return Some(found);
                    }
                }
            }
            _ => {}
        }
        None
    }

    helper(StateNode::Borrowed(root), allow_empty)
}

fn is_deposit_map(value: &StateValue, allow_empty: bool) -> bool {
    let StateValue::Map(map) = value else {
        return false;
    };
    if map.size() == 0 {
        return allow_empty;
    }
    let mut has_deposit = false;
    for entry in map.iter() {
        let (key_sp, value_sp) = entry.deref();
        if decode_u64(key_sp.deref()).is_err() {
            return false;
        }
        if matches!(value_sp.deref(), StateValue::Null) {
            continue;
        }
        match decode_deposit(value_sp.deref()) {
            Ok(Some(_)) => {
                has_deposit = true;
            }
            _ => return false,
        }
    }
    has_deposit
}

fn extract_deposits(value: &StateValue) -> Result<BTreeMap<u64, Deposit>> {
    match value {
        StateValue::Map(map) => {
            let mut result = BTreeMap::new();
            for pair in map.iter() {
                let (key_sp, value_sp) = pair.deref();
                let idx = decode_u64(key_sp.deref())?;
                if let Some(deposit) = decode_deposit(value_sp.deref())? {
                    result.insert(idx, deposit);
                }
            }
            Ok(result)
        }
        _ => Err(anyhow!("expected deposits map")),
    }
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

enum StateNode<'a> {
    Borrowed(&'a StateValue),
    Owned(Sp<StateValue>),
}

impl<'a> StateNode<'a> {
    fn as_ref(&self) -> &StateValue {
        match self {
            StateNode::Borrowed(value) => value,
            StateNode::Owned(sp) => sp.deref(),
        }
    }
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
