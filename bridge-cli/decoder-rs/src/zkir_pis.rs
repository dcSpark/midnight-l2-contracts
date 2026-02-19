//! Collect declared public inputs (pis) from commitBatch zkir by running a minimal VM.
//! Used to build the guaranteed_public_transcript so PiSkip checks pass.
//! Mirrors the preprocess loop from midnight-ledger zkir/ir_vm.rs (we cannot call it; pub(crate)).

use anyhow::{anyhow, bail, Result};
use midnight_node_ledger_helpers::transient_crypto::curve::Fr;
use midnight_node_ledger_helpers::transient_crypto::proofs::ProofPreimage;
use num_bigint::BigUint;
use serialize::tagged_deserialize;
use transient_crypto::curve::Fr as LedgerFr;
use zkir::{Instruction as I, IrSource};

/// Converts Fr from the ledger’s transient_crypto (used by zkir) to the helpers’ Fr.
fn fr_from_ledger(l: &LedgerFr) -> Fr {
    Fr::from_le_bytes(&l.as_le_bytes()).expect("Fr bytes must be valid")
}

const FR_BITS: usize = 255;
const FR_BYTES_STORED: usize = 31;

/// Runs the zkir instruction loop to collect the declared public input sequence (pis).
/// At PiSkip we do not check preimage vs pis (we are building the transcript).
/// Returns the full pis (binding_input, comm_comm?, then each DeclarePubInput value).
pub fn collect_pis(ir_source: &[u8], preimage: &ProofPreimage) -> Result<Vec<Fr>> {
    let ir: IrSource = tagged_deserialize(&mut &ir_source[..])
        .map_err(|e| anyhow!("failed to deserialize zkir: {}", e))?;

    if preimage.inputs.len() != ir.num_inputs as usize {
        bail!(
            "expected {} inputs, got {}",
            ir.num_inputs,
            preimage.inputs.len()
        );
    }

    let mut memory: Vec<Fr> = preimage.inputs.clone();
    let mut pis = vec![preimage.binding_input];
    if ir.do_communications_commitment {
        let (comm, _) = preimage
            .communications_commitment
            .ok_or_else(|| anyhow!("expected communications commitment"))?;
        pis.push(comm);
    }

    let mut public_transcript_outputs_idx: usize = 0;
    let mut private_transcript_outputs_idx: usize = 0;

    let idx = |memory: &[Fr], i: u32| {
        memory
            .get(i as usize)
            .copied()
            .ok_or_else(|| anyhow!("index out of bounds: {}", i))
    };
    let idx_bool = |memory: &[Fr], i: u32| {
        let val = idx(memory, i)?;
        if val == Fr::default() {
            Ok(false)
        } else if val == Fr::from(1u64) {
            Ok(true)
        } else {
            bail!("expected boolean at {}: {:?}", i, val)
        }
    };
    let idx_bits = |memory: &[Fr], i: u32, constrain: Option<u32>| {
        let val = idx(memory, i)?;
        let mut bits: Vec<bool> = val
            .0
            .to_bytes_le()
            .into_iter()
            .flat_map(|byte| {
                [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80]
                    .into_iter()
                    .map(move |mask| byte & mask != 0)
            })
            .collect();
        if let Some(n) = constrain {
            if n as usize >= FR_BITS {
                bail!("excessive bit bound");
            }
            if bits[n as usize..].iter().any(|b| *b) {
                bail!("bit bound failed: {:?} is not {}-bit", val, n);
            }
            bits.truncate(n as usize);
        }
        Ok(bits)
    };
    fn from_bits<I: DoubleEndedIterator<Item = bool>>(bits: I) -> Fr {
        bits.rev()
            .fold(Fr::default(), |acc, bit| acc * Fr::from(2u64) + Fr::from(bit as u64))
    }
    fn fr_as_biguint(f: &Fr) -> BigUint {
        BigUint::from_bytes_le(&f.0.to_bytes_le())
    }

    for (ins_index, ins) in ir.instructions.iter().enumerate() {
        let start_idx = memory.len();
        match ins {
            I::LoadImm { imm } => memory.push(fr_from_ledger(imm)),
            I::PrivateInput { guard } => match guard {
                Some(guard) if !idx_bool(&memory, *guard)? => memory.push(Fr::default()),
                _ => {
                    memory.push(
                        preimage
                            .private_transcript
                            .get(private_transcript_outputs_idx)
                            .copied()
                            .ok_or_else(|| anyhow!("ran out of private transcript outputs"))?,
                    );
                    private_transcript_outputs_idx += 1;
                }
            },
            I::DeclarePubInput { var } => {
                pis.push(idx(&memory, *var)?);
            }
            I::PiSkip { guard, count: _ } => {
                // Collect-only: do not check preimage.public_transcript_inputs
                match guard {
                    Some(guard) if !idx_bool(&memory, *guard)? => {}
                    _ => {}
                }
            }
            I::PublicInput { guard } => {
                let val = match guard {
                    Some(guard) if !idx_bool(&memory, *guard)? => Fr::default(),
                    _ => {
                        public_transcript_outputs_idx += 1;
                        preimage
                            .public_transcript_outputs
                            .get(public_transcript_outputs_idx - 1)
                            .copied()
                            .unwrap_or(Fr::default())
                    }
                };
                memory.push(val);
            }
            I::ConstrainBits { var, bits } => {
                drop(idx_bits(&memory, *var, Some(*bits))?);
            }
            I::Copy { var } => memory.push(idx(&memory, *var)?),
            I::Add { a, b } => memory.push(idx(&memory, *a)? + idx(&memory, *b)?),
            I::Assert { cond } => {
                let cond_val = idx(&memory, *cond)?;
                if !idx_bool(&memory, *cond)? {
                    bail!(
                        "assert failed at instruction {} (Assert cond at memory[{}] = {:?}). \
                         For commitBatch this is usually BAD_PARENT_BATCH_HASH or MISSING_PARENT_COMMIT: \
                         collect_pis runs zkir with a preimage that has no ledger state (public_transcript_outputs \
                         empty), so expectedParent and member results are 0; the circuit then asserts \
                         parentBatchHash == expectedParent and fails when parentBatchHash is non-zero.",
                        ins_index,
                        cond,
                        cond_val
                    );
                }
            }
            I::TestEq { a, b } => {
                let eq = idx(&memory, *a)? == idx(&memory, *b)?;
                memory.push(Fr::from(eq));
            }
            I::CondSelect { bit, a, b } => {
                let (bit, a, b) = (
                    idx_bool(&memory, *bit)?,
                    idx(&memory, *a)?,
                    idx(&memory, *b)?,
                );
                memory.push(if bit { a } else { b });
            }
            I::DivModPowerOfTwo { var, bits } => {
                if *bits as usize > FR_BYTES_STORED * 8 {
                    bail!("excessive bit count");
                }
                let var_bits = idx_bits(&memory, *var, None)?;
                memory.push(from_bits(var_bits[*bits as usize..].iter().copied()));
                memory.push(from_bits(var_bits[..*bits as usize].iter().copied()));
            }
            I::ReconstituteField {
                divisor,
                modulus,
                bits,
            } => {
                if *bits as usize > FR_BYTES_STORED * 8 {
                    bail!("excessive bit count");
                }
                let power = (0..*bits).fold(Fr::from(1u64), |acc, _| Fr::from(2u64) * acc);
                memory.push(
                    power * idx(&memory, *divisor)? + idx(&memory, *modulus)?,
                );
            }
            I::LessThan { a, b, bits } => {
                let a_fr = from_bits(idx_bits(&memory, *a, Some(*bits))?.into_iter());
                let b_fr = from_bits(idx_bits(&memory, *b, Some(*bits))?.into_iter());
                let a_int = fr_as_biguint(&a_fr);
                let b_int = fr_as_biguint(&b_fr);
                memory.push(Fr::from(a_int < b_int));
            }
            _ => bail!("unsupported zkir instruction in commitBatch: {:?}", ins),
        }
        let _ = start_idx;
    }

    if preimage.private_transcript.len() != private_transcript_outputs_idx {
        bail!(
            "private transcript length mismatch: preimage has {}, consumed {}",
            preimage.private_transcript.len(),
            private_transcript_outputs_idx
        );
    }

    Ok(pis)
}

/// Slice of pis that the transcript must produce (skip binding and comm_comm).
pub fn declared_pis_for_transcript(pis: &[Fr], do_communications_commitment: bool) -> &[Fr] {
    let skip = if do_communications_commitment { 2 } else { 1 };
    if pis.len() > skip {
        &pis[skip..]
    } else {
        &[]
    }
}

/// Returns the number of `PublicInput` instructions in the zkir (order matches execution).
pub fn count_public_inputs(ir_source: &[u8]) -> Result<usize> {
    let ir: IrSource = tagged_deserialize(&mut &ir_source[..])
        .map_err(|e| anyhow!("failed to deserialize zkir: {}", e))?;
    Ok(ir
        .instructions
        .iter()
        .filter(|i| matches!(i, I::PublicInput { .. }))
        .count())
}
