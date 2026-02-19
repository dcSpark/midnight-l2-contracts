use anyhow::{anyhow, bail, Result};
use midnight_node_ledger_helpers::base_crypto::fab::AlignedValue;
use midnight_node_ledger_helpers::{
    ContractAction, ContractAddress, DefaultDB, EntryPointBuf, FromContext, IntentCustom,
    IntentInfo, LedgerContext, LocalProofServer, ProofPreimageMarker, ProofProvider, Resolver,
    SerdeTransaction, Sp, StandardTrasactionInfo, WalletSeed,
};
use midnight_node_ledger_helpers::mn_ledger::construct::ContractCallExt;
use midnight_node_ledger_helpers::mn_ledger::construct::ContractCallPrototype;
use midnight_node_ledger_helpers::mn_ledger::structure::{ContractCall, ProofPreimageVersioned};
use midnight_node_ledger_helpers::onchain_runtime::state::{ContractState, StateValue};
use rand::{rngs::OsRng, Rng};
use midnight_node_ledger_helpers::transient_crypto::curve::Fr;
use midnight_node_ledger_helpers::transient_crypto::proofs::{KeyLocation, ProofPreimage};
use midnight_node_ledger_helpers::base_crypto::hash::HashOutput;
use midnight_node_ledger_helpers::base_crypto::cost_model::RunningCost;
use midnight_node_ledger_helpers::ledger_storage::storage::Array;
use midnight_node_ledger_helpers::onchain_runtime::communication_commitment;
use midnight_node_ledger_helpers::onchain_runtime::context::Effects;
use midnight_node_ledger_helpers::onchain_runtime::ops::{Key, Op};
use midnight_node_ledger_helpers::onchain_runtime::result_mode::ResultModeVerify;
use midnight_node_ledger_helpers::onchain_runtime::transcript::Transcript;
use midnight_node_toolkit::client::MidnightNodeClient;
use midnight_node_toolkit::remote_prover::RemoteProofServer;
use midnight_node_toolkit::sender::Sender;
use midnight_node_toolkit::tx_generator::source::{FetchCacheConfig, GetTxs, GetTxsFromUrl};
use midnight_node_toolkit::serde_def::SourceTransactions;
use midnight_node_toolkit::{ProofType, SignatureType};
use std::path::Path;
use std::sync::Arc;
use std::io::Read;
use std::io::Write;

const DEBUG_LOG_PATH: &str = "/home/ladislav/prj/MidnightL2/midnight-l2-contracts/.cursor/debug.log";

use crate::bridge_abi::{
    encode_commit_batch, encode_finalize_batch, finalize_batch_output_alignment,
    finalize_batch_output_value, commit_batch_output_alignment, commit_batch_output_value,
    commit_batch_output_as_bytes32_aligned_value, byte_aligned_value,
    aligned_value_from_single_fr, bytes32_to_public_output_fr, fr_to_u8, fr_to_u32,
};
use crate::bridge_batch::{
    build_batch_public_data, build_signature_vector, commit_batch_hash_override,
    default_signer_bitmap, ensure_committed_batch, hash_batch_public_data_v1_full,
    random_bytes32, snapshot_from_ledger, RollupSnapshot,
};
use crate::bridge_signatures::derive_pk;
use crate::zkir_pis;
use crate::{BatchArgs, BridgeLedger};

// #region agent log
fn debug_log_preimage_public_inputs(proof: &ProofPreimageVersioned, path_name: &str) {
    if let ProofPreimageVersioned::V2(arc) = proof {
        let p = arc.as_ref();
        let len = p.public_transcript_inputs.len();
        let index_8_u8 = p.public_transcript_inputs.get(8).and_then(crate::bridge_abi::fr_to_u8);
        let first_10_u8: Vec<Option<u8>> = p.public_transcript_inputs.iter().take(10).map(crate::bridge_abi::fr_to_u8).collect();
        let payload = serde_json::json!({
            "timestamp": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis(),
            "location": "bridge_tx.rs:build_placeholder_call",
            "message": "preimage public_transcript_inputs (as built by ledger)",
            "data": { "path": path_name, "len": len, "index_8_u8": index_8_u8, "first_10_u8": first_10_u8, "hypothesisId": "H1" }
        });
        if let Some(parent) = Path::new(DEBUG_LOG_PATH).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(DEBUG_LOG_PATH) {
            let _ = writeln!(f, "{}", payload);
        }
    }
}
// #endregion

pub struct ContractCallPlan {
    pub entry_point: &'static str,
    pub input: AlignedValue,
    pub output: AlignedValue,
    /// Extra values supplied to the circuit's private transcript (e.g. commitBatch return as Bytes<32>).
    pub private_transcript_outputs: Vec<AlignedValue>,
    /// For commitBatch only: ledger-derived values for PublicInput (so collect_pis can run without assert failure).
    pub commit_batch_public_outputs: Option<Vec<Fr>>,
}

pub async fn build_commit_batch_plan(args: &BatchArgs, ledger: &BridgeLedger) -> Result<ContractCallPlan> {
    let snapshot = snapshot_from_ledger(ledger);
    let parent_index = snapshot.last_committed_batch_index;
    let parent_batch_hash = ensure_committed_batch(&ledger.rollup, parent_index)?;
    let batch_hash = commit_batch_hash_override(args.batch_hash.as_deref())?.unwrap_or_else(random_bytes32);

    let input = encode_commit_batch(parent_batch_hash, batch_hash)?;
    let output_alignment = commit_batch_output_alignment();
    let new_batch_index = parent_index + 1;
    let output_value = commit_batch_output_value(new_batch_index);
    let output = AlignedValue::new(output_value, output_alignment)
        .ok_or_else(|| anyhow!("commitBatch output not aligned"))?;
    let private_transcript_outputs = vec![commit_batch_output_as_bytes32_aligned_value(new_batch_index)?];

    let commit_batch_public_outputs = {
        let zkir_path = Path::new(&args.bridge_artifacts).join("zkir").join("commitBatch.bzkir");
        let mut f = std::fs::File::open(&zkir_path)
            .map_err(|e| anyhow!("open zkir {:?}: {}", zkir_path, e))?;
        let mut zkir_bytes = Vec::new();
        f.read_to_end(&mut zkir_bytes)
            .map_err(|e| anyhow!("read zkir: {}", e))?;
        let count = zkir_pis::count_public_inputs(&zkir_bytes)?;
        match commit_batch_public_outputs_from_snapshot(&snapshot, parent_batch_hash, count) {
            Ok(outputs) => Some(outputs),
            Err(e) => {
                eprintln!(
                    "commit_batch_public_outputs_from_snapshot skipped (zkir has {} PublicInputs, we only synthesize 5): {}",
                    count, e
                );
                None
            }
        }
    };

    Ok(ContractCallPlan {
        entry_point: "commitBatch",
        input,
        output,
        private_transcript_outputs,
        commit_batch_public_outputs,
    })
}

pub async fn build_finalize_batch_plan(args: &BatchArgs, ledger: &BridgeLedger) -> Result<ContractCallPlan> {
    let snapshot = snapshot_from_ledger(ledger);
    let batch_index = snapshot.last_finalized_batch_index + 1;
    let batch_hash = ensure_committed_batch(&ledger.rollup, batch_index)?;
    let batch_public_data = build_batch_public_data(ledger, &snapshot, batch_hash)?;
    let digest = hash_batch_public_data_v1_full(&batch_public_data);
    let signatures = build_signature_vector(digest, Some(args.signature_max_nonce))?;
    let signer_bitmap = default_signer_bitmap();
    let finalize_timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|err| anyhow!("invalid system clock: {err}"))?
        .as_secs();

    let input = encode_finalize_batch(&batch_public_data, &signatures, signer_bitmap, finalize_timestamp)?;
    let output_alignment = finalize_batch_output_alignment();
    let output_value = finalize_batch_output_value();
    let output = AlignedValue::new(output_value, output_alignment)
        .ok_or_else(|| anyhow!("finalizeBatch output not aligned"))?;

    Ok(ContractCallPlan {
        entry_point: "finalizeBatch",
        input,
        output,
        private_transcript_outputs: Vec::new(),
        commit_batch_public_outputs: None,
    })
}

pub async fn submit_plan(
    args: &BatchArgs,
    plan: &ContractCallPlan,
    contract_state: &ContractState<DefaultDB>,
) -> Result<()> {
    let call = build_placeholder_call(args, plan, contract_state)?;
    let resolver = resolve_bridge_artifacts(&args.bridge_artifacts)?;

    let proof_provider: Arc<dyn ProofProvider<DefaultDB>> = if args.local_prover {
        Arc::new(LocalProofServer::new())
    } else {
        Arc::new(RemoteProofServer::new(args.proof_server.clone()))
    };

    let source_txs = fetch_chain_history_with_retry(&args.node_ws, args.fetch_concurrency).await?;

    let network_id = resolve_network_id(&source_txs, &args.node_ws).await?;
    let funding_seed: WalletSeed = args
        .funding_seed
        .parse()
        .map_err(|err| anyhow!("invalid funding seed: {err}"))?;

    let context = LedgerContext::new_from_wallet_seeds(network_id, &[funding_seed]);
    for block in source_txs.blocks {
        context.update_from_block(
            block.transactions,
            block.context,
            block.state_root,
        );
    }
    let context_arc = Arc::new(context);

    let mut tx_info = StandardTrasactionInfo::new_from_context(
        context_arc.clone(),
        proof_provider.clone(),
        None,
    );

    let custom_intent = IntentCustom::new_from_actions(
        &mut OsRng,
        &[ContractAction::Call(Sp::new(call))],
        resolver,
    );
    let intent_info = IntentInfo {
        guaranteed_unshielded_offer: None,
        fallible_unshielded_offer: None,
        actions: vec![Box::new(custom_intent)],
    };
    tx_info.add_intent(1, Box::new(intent_info));
    tx_info.set_funding_seeds(vec![funding_seed]);

    let proven_tx = tx_info
        .prove()
        .await
        .map_err(|err| anyhow!("failed to prove transaction: {err}"))?;
    let serde_tx: SerdeTransaction<SignatureType, ProofType, DefaultDB> =
        SerdeTransaction::Midnight(proven_tx);

    let sender = Sender::<SignatureType, ProofType>::new(&vec![args.node_ws.clone()], false)
        .await
        .map_err(|err| anyhow!("failed to connect sender: {err}"))?;
    sender
        .send_tx(&serde_tx)
        .await
        .map_err(|err| anyhow!("failed to submit tx: {err}"))?;

    Ok(())
}

async fn fetch_chain_history_with_retry(
    node_ws: &str,
    fetch_concurrency: usize,
) -> Result<SourceTransactions<SignatureType, ProofType>> {
    let source = GetTxsFromUrl::new(
        node_ws,
        fetch_concurrency,
        false,
        FetchCacheConfig::InMemory,
    );

    match source.get_txs().await {
        Ok(txs) => Ok(txs),
        Err(primary_err) => {
            if fetch_concurrency > 1 {
                eprintln!(
                    "Warning: chain-history fetch failed with fetch-concurrency={}; retrying with 1.",
                    fetch_concurrency
                );
                let retry_source = GetTxsFromUrl::new(
                    node_ws,
                    1,
                    false,
                    FetchCacheConfig::InMemory,
                );
                return retry_source.get_txs().await.map_err(|retry_err| {
                    anyhow!(
                        "failed to fetch chain history: {:?}; retry with fetch-concurrency=1 also failed: {:?}",
                        primary_err,
                        retry_err
                    )
                });
            }

            Err(anyhow!(
                "failed to fetch chain history: {:?}; verify MIDNIGHT_NODE_WS points to a running node",
                primary_err
            ))
        }
    }
}

fn resolve_bridge_artifacts(path: &str) -> Result<&'static Resolver> {
    let abs = Path::new(path)
        .canonicalize()
        .map_err(|err| anyhow!("failed to resolve bridge artifacts dir at {path}: {err}"))?;
    let resolver = IntentCustom::<DefaultDB>::get_resolver(&[abs
        .to_string_lossy()
        .to_string()])?;
    Ok(Box::leak(Box::new(resolver)))
}

async fn resolve_network_id(
    source_txs: &midnight_node_toolkit::serde_def::SourceTransactions<SignatureType, ProofType>,
    node_url: &str,
) -> Result<String> {
    if let Some(id) = source_txs
        .blocks
        .iter()
        .find_map(|b| b.transactions.iter().find_map(|tx| tx.network_id()))
    {
        return Ok(id.to_string());
    }

    let client = MidnightNodeClient::new(node_url)
        .await
        .map_err(|err| anyhow!("failed to connect to node: {err}"))?;
    client
        .get_network_id()
        .await
        .map_err(|err| anyhow!("failed to fetch network id: {err}"))
}

fn build_placeholder_call(
    args: &BatchArgs,
    plan: &ContractCallPlan,
    contract_state: &ContractState<DefaultDB>,
) -> Result<ContractCall<ProofPreimageMarker, DefaultDB>> {
    let address_bytes = hex::decode(args.contract.trim())
        .map_err(|err| anyhow!("invalid contract address: {err}"))?;
    let address_bytes: [u8; 32] = address_bytes
        .try_into()
        .map_err(|_| anyhow!("contract address must be 32 bytes"))?;
    let address = ContractAddress(HashOutput(address_bytes));

    let entry_point = EntryPointBuf(plan.entry_point.as_bytes().to_vec());
    let op = contract_state
        .operations
        .get(&entry_point)
        .map(|op| (*op).clone())
        .ok_or_else(|| anyhow!("missing contract operation for {}", plan.entry_point))?;

    let comm_rand = OsRng.r#gen();
    let mut commit_batch_path: Option<&'static str> = None;
    let (guaranteed_transcript, fallible_transcript) = if plan.entry_point == "commitBatch" {
        let call_proto_temp = ContractCallPrototype::<DefaultDB> {
            address,
            entry_point: entry_point.clone(),
            op: op.clone(),
            guaranteed_public_transcript: None,
            fallible_public_transcript: None,
            private_transcript_outputs: plan.private_transcript_outputs.clone(),
            input: plan.input.clone(),
            output: plan.output.clone(),
            communication_commitment_rand: comm_rand,
            key_location: KeyLocation(std::borrow::Cow::Owned(plan.entry_point.to_string())),
        };
        let comm = communication_commitment(
            call_proto_temp.input.clone(),
            call_proto_temp.output.clone(),
            call_proto_temp.communication_commitment_rand,
        );
        let preimage = ProofPreimage::construct_proof(&call_proto_temp, comm);
        // If we have ledger-derived public_outputs (Option 2), use a preimage with them so collect_pis succeeds.
        let preimage_for_zkir = match &preimage {
            ProofPreimageVersioned::V2(arc) if plan.commit_batch_public_outputs.is_some() => {
                let mut p = (**arc).clone();
                p.public_transcript_outputs = plan.commit_batch_public_outputs.clone().unwrap();
                ProofPreimageVersioned::V2(Arc::new(p))
            }
            _ => preimage.clone(),
        };
        let (transcript, path_name) = match commit_batch_transcript_from_zkir(args, &preimage_for_zkir) {
            Ok(t) => (t, "zkir"),
            Err(e) => {
                eprintln!("commit_batch_transcript_from_zkir failed (using minimal transcript): {}", e);
                (commit_batch_public_transcript().expect("minimal transcript"), "minimal")
            }
        };
        commit_batch_path = Some(path_name);
        (Some(transcript), None)
    } else {
        (None, None)
    };

    let call_proto: ContractCallPrototype<DefaultDB> = ContractCallPrototype {
        address,
        entry_point: entry_point.clone(),
        op,
        guaranteed_public_transcript: guaranteed_transcript,
        fallible_public_transcript: fallible_transcript,
        private_transcript_outputs: plan.private_transcript_outputs.clone(),
        input: plan.input.clone(),
        output: plan.output.clone(),
        communication_commitment_rand: comm_rand,
        key_location: KeyLocation(std::borrow::Cow::Owned(plan.entry_point.to_string())),
    };
    let comm = communication_commitment(
        call_proto.input.clone(),
        call_proto.output.clone(),
        call_proto.communication_commitment_rand,
    );
    let proof = ProofPreimage::construct_proof(&call_proto, comm);
    if let Some(path_name) = commit_batch_path {
        debug_log_preimage_public_inputs(&proof, path_name);
    }

    Ok(ContractCall::new(
        address,
        entry_point,
        None,
        None,
        comm,
        proof,
    ))
}

/// Builds the public_transcript_outputs for commitBatch so collect_pis can run (no empty ledger).
/// Order matches L1Rollup.compact commitBatch: onlySequencer (1), lastCommittedBatchIndex (1),
/// committedBatches.member (1), committedBatches.lookup (2 Fr for Bytes<32>). Total 5.
///
/// The compiled zkir often has many more than 5 PublicInput instructions (e.g. 29), because each
/// logical ledger read (miscData.lastCommittedBatchIndex, committedBatches.member, .lookup) is
/// lowered into multiple low-level ops (Idx path steps, Member/Lookup internals), each consuming
/// one transcript output. We only know how to synthesize the 5 high-level values; when the zkir
/// has a different count we return an error and the caller skips injection (falls back to minimal transcript).
fn commit_batch_public_outputs_from_snapshot(
    snapshot: &RollupSnapshot,
    parent_batch_hash: [u8; 32],
    expected_count: usize,
) -> Result<Vec<Fr>> {
    let one = Fr::from(1u64);
    let last_committed = Fr::from(snapshot.last_committed_batch_index);
    let lookup_fr = bytes32_to_public_output_fr(parent_batch_hash)?;
    let mut out = vec![one, last_committed, one];
    out.extend(lookup_fr);
    if out.len() != expected_count {
        bail!(
            "commitBatch zkir has {} PublicInput instructions (compiler expands each logical read into many); we only synthesize 5",
            expected_count
        );
    }
    Ok(out)
}

/// Loads commitBatch zkir, runs collect_pis, and builds a transcript whose ops output the declared pis.
fn commit_batch_transcript_from_zkir(
    args: &BatchArgs,
    preimage: &ProofPreimageVersioned,
) -> Result<Transcript<DefaultDB>> {
    let preimage = match preimage {
        ProofPreimageVersioned::V2(arc) => arc.as_ref(),
        _ => return Err(anyhow!("unsupported ProofPreimageVersioned variant")),
    };
    let zkir_path = Path::new(&args.bridge_artifacts).join("zkir").join("commitBatch.bzkir");
    let mut f = std::fs::File::open(&zkir_path)
        .map_err(|e| anyhow!("open zkir {:?}: {}", zkir_path, e))?;
    let mut zkir_bytes = Vec::new();
    f.read_to_end(&mut zkir_bytes)
        .map_err(|e| anyhow!("read zkir: {}", e))?;
    let pis = zkir_pis::collect_pis(&zkir_bytes, preimage)?;
    let declared = zkir_pis::declared_pis_for_transcript(&pis, true);
    let program = pis_to_ops(declared)?;
    Ok(Transcript {
        gas: RunningCost::default(),
        effects: Effects::default(),
        program: program.into_iter().collect(),
        version: None,
    })
}

/// Parses the declared public-input stream into ops whose field_repr reproduces it.
fn pis_to_ops(declared: &[Fr]) -> Result<Vec<Op<ResultModeVerify, DefaultDB>>> {
    let mut ops = Vec::new();
    let mut i = 0;
    while i < declared.len() {
        let b = fr_to_u8(&declared[i])
            .ok_or_else(|| anyhow!("transcript stream element at {} does not fit in u8", i))?;
        match b {
            0x30..=0x3f => {
                ops.push(Op::Dup { n: b & 0xf });
                i += 1;
            }
            0x00 => {
                let mut n = 0usize;
                while i < declared.len() && fr_to_u8(&declared[i]) == Some(0) {
                    n += 1;
                    i += 1;
                }
                ops.push(Op::Noop {
                    n: n.try_into().map_err(|_| anyhow!("Noop count overflow"))?,
                });
            }
            0x50..=0x5f => {
                let path_len = (b - 0x50) as usize + 1;
                if i + 1 + path_len > declared.len() {
                    bail!("Idx at {}: not enough path entries", i);
                }
                let path: Array<Key, DefaultDB> = (0..path_len)
                    .map(|j| {
                        let v = fr_to_u8(&declared[i + 1 + j])
                            .ok_or_else(|| anyhow!("Idx path entry not u8"))?;
                        Ok(Key::Value(byte_aligned_value(v)?))
                    })
                    .collect::<Result<Vec<_>>>()?
                    .into_iter()
                    .collect();
                ops.push(Op::Idx {
                    cached: false,
                    push_path: false,
                    path,
                });
                i += 1 + path_len;
            }
            0x0c | 0x0d => {
                let cached = b == 0x0d;
                i += 1;
                if i >= declared.len() {
                    bail!("Popeq at {}: missing result", i - 1);
                }
                let result = aligned_value_from_single_fr(declared[i])?;
                ops.push(Op::Popeq { cached, result });
                i += 1;
            }
            0x0e => {
                i += 1;
                if i >= declared.len() {
                    bail!("Addi at {}: missing immediate", i - 1);
                }
                let immediate = fr_to_u32(&declared[i])
                    .ok_or_else(|| anyhow!("Addi at {}: immediate not u32", i))?;
                ops.push(Op::Addi { immediate });
                i += 1;
            }
            0x0f => {
                i += 1;
                if i >= declared.len() {
                    bail!("Subi at {}: missing immediate", i - 1);
                }
                let immediate = fr_to_u32(&declared[i])
                    .ok_or_else(|| anyhow!("Subi at {}: immediate not u32", i))?;
                ops.push(Op::Subi { immediate });
                i += 1;
            }
            0x10 | 0x11 => {
                let storage = b == 0x11;
                i += 1;
                if i >= declared.len() {
                    bail!("Push at {}: missing StateValue discriminant", i - 1);
                }
                let disc = fr_to_u8(&declared[i])
                    .ok_or_else(|| anyhow!("Push at {}: discriminant not u8", i))?;
                i += 1;
                if disc != 1 {
                    bail!("Push at {}: unsupported StateValue variant {}", i - 2, disc);
                }
                if i >= declared.len() {
                    bail!("Push at {}: missing Cell value", i - 1);
                }
                let cell_val = aligned_value_from_single_fr(declared[i])?;
                ops.push(Op::Push {
                    storage,
                    value: StateValue::Cell(Sp::new(cell_val)),
                });
                i += 1;
            }
            // Single-byte ops (field_repr is one element): Lt, Eq, Type, Size, New, And, Or, Neg, Log, Root, Pop
            0x01 => { ops.push(Op::Lt); i += 1; }
            0x02 => { ops.push(Op::Eq); i += 1; }
            0x03 => { ops.push(Op::Type); i += 1; }
            0x04 => { ops.push(Op::Size); i += 1; }
            0x05 => { ops.push(Op::New); i += 1; }
            0x06 => { ops.push(Op::And); i += 1; }
            0x07 => { ops.push(Op::Or); i += 1; }
            0x08 => { ops.push(Op::Neg); i += 1; }
            0x09 => { ops.push(Op::Log); i += 1; }
            0x0a => { ops.push(Op::Root); i += 1; }
            0x0b => { ops.push(Op::Pop); i += 1; }
            // Swap { n } -> 0x40 | n
            0x40..=0x4f => {
                ops.push(Op::Swap { n: b & 0xf });
                i += 1;
            }
            _ => bail!("unsupported opcode in transcript stream at {}: 0x{:02x}", i, b),
        }
    }
    Ok(ops)
}

/// Builds the public transcript for commitBatch so that the circuit's PiSkip checks pass.
/// The commitBatch zkir declares many public inputs; the transcript's op field_repr outputs must
/// match that sequence. This minimal implementation (fallback) supplies only the first value (0x30 = 48)
/// so we get past the first PiSkip. Prefer commit_batch_transcript_from_zkir which collects
/// full `pis` from zkir and builds a transcript that outputs that sequence (see COMMIT_BATCH_DEV_STATE.md).
/// We use Dup { n } because its field_repr is a single element (0x30|n); Addi would emit
/// [opcode, immediate] so the first public input would be the opcode, not the value.
/// First declared public inputs in commitBatch.zkir: 0x30, then 0x51, ... (then 0x0a at index 8).
/// The circuit expects at least 9 public inputs; index 8 must be 0x0a (Op::Root).
/// Dup yields 1 element; Idx with 2 path entries yields 1 + (path field_repr) elements—Key::Value
/// field_repr can be multiple elements, so we do not insert Noop so that Root lands at index 8.
/// Log evidence: with Noop(4)+Root we had len=13 and index_8=0 (Root was at 12); remove Noop(4).
fn commit_batch_public_transcript() -> Result<Transcript<DefaultDB>> {
    let path: Array<Key, DefaultDB> = vec![
        Key::Value(byte_aligned_value(0)?),
        Key::Value(byte_aligned_value(5)?),
    ]
    .into_iter()
    .collect();
    let program: Array<Op<ResultModeVerify, DefaultDB>, DefaultDB> = vec![
        Op::Dup { n: 0 },
        Op::Idx {
            cached: false,
            push_path: false,
            path,
        },
        Op::Root,
    ]
    .into();
    Ok(Transcript {
        gas: RunningCost::default(),
        effects: Effects::default(),
        program,
        version: None,
    })
}

#[allow(dead_code)]
fn derive_default_verifier_set() -> [crate::bridge_abi::CurvePoint; 3] {
    let pk0 = derive_pk(Fr::from(101u64));
    let pk1 = derive_pk(Fr::from(102u64));
    let pk2 = derive_pk(Fr::from(103u64));
    [pk0, pk1, pk2]
}
