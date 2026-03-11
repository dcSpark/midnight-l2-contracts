use anyhow::{Result, anyhow};
use sha2::{Digest, Sha256};

pub const WITHDRAW_TREE_DEPTH: usize = 16;
pub const ZERO_BYTES_32: [u8; 32] = [0u8; 32];

fn pad_ascii_32(text: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    let src = text.as_bytes();
    let len = src.len().min(32);
    out[..len].copy_from_slice(&src[..len]);
    out
}

fn u_to_bytes32_le_u64(value: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..8].copy_from_slice(&value.to_le_bytes());
    out
}

fn u_to_bytes32_le_u128(value: u128) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..16].copy_from_slice(&value.to_le_bytes());
    out
}

fn sha256(data: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest(data);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

pub fn hash_l2_to_l1_withdraw(
    sender: [u8; 32],
    recipient: [u8; 32],
    amount: u128,
    nonce: u64,
) -> [u8; 32] {
    let ds = pad_ascii_32("mdn:l2l1:wdraw");
    let mut preimage = Vec::with_capacity(32 * 5);
    preimage.extend_from_slice(&ds);
    preimage.extend_from_slice(&sender);
    preimage.extend_from_slice(&recipient);
    preimage.extend_from_slice(&u_to_bytes32_le_u128(amount));
    preimage.extend_from_slice(&u_to_bytes32_le_u64(nonce));
    sha256(&preimage)
}

pub fn compute_withdraw_leaf(message_hash: [u8; 32]) -> [u8; 32] {
    let ds = pad_ascii_32("mdn:l2w:leaf");
    let mut preimage = Vec::with_capacity(64);
    preimage.extend_from_slice(&ds);
    preimage.extend_from_slice(&message_hash);
    sha256(&preimage)
}

pub fn compute_merkle_node_hash(left: [u8; 32], right: [u8; 32]) -> [u8; 32] {
    let mut preimage = Vec::with_capacity(64);
    preimage.extend_from_slice(&left);
    preimage.extend_from_slice(&right);
    sha256(&preimage)
}

pub fn compute_merkle_root(leaves: &[[u8; 32]], tree_depth: usize) -> Result<[u8; 32]> {
    let num_leaves = 1usize << tree_depth;
    if leaves.len() > num_leaves {
        return Err(anyhow!(
            "too many leaves: got {}, max {} for depth={}",
            leaves.len(),
            num_leaves,
            tree_depth
        ));
    }
    let mut current_level = vec![ZERO_BYTES_32; num_leaves];
    current_level[..leaves.len()].copy_from_slice(leaves);

    let mut level_size = num_leaves;
    while level_size > 1 {
        let next_size = level_size / 2;
        for i in 0..next_size {
            current_level[i] = compute_merkle_node_hash(current_level[2 * i], current_level[2 * i + 1]);
        }
        level_size = next_size;
    }
    Ok(current_level[0])
}

pub fn generate_merkle_proof(
    leaves: &[[u8; 32]],
    leaf_index: usize,
    tree_depth: usize,
) -> Result<Vec<[u8; 32]>> {
    let num_leaves = 1usize << tree_depth;
    if leaf_index >= num_leaves {
        return Err(anyhow!(
            "leaf index {} out of range [0, {})",
            leaf_index,
            num_leaves
        ));
    }
    if leaves.len() > num_leaves {
        return Err(anyhow!(
            "too many leaves: got {}, max {} for depth={}",
            leaves.len(),
            num_leaves,
            tree_depth
        ));
    }

    let mut current_level = vec![ZERO_BYTES_32; num_leaves];
    current_level[..leaves.len()].copy_from_slice(leaves);

    let mut proof = Vec::with_capacity(tree_depth);
    let mut current_index = leaf_index;
    for _level in 0..tree_depth {
        let sibling_index = current_index ^ 1;
        proof.push(current_level[sibling_index]);

        let next_size = current_level.len() / 2;
        let mut next_level = vec![ZERO_BYTES_32; next_size];
        for i in 0..next_size {
            next_level[i] = compute_merkle_node_hash(current_level[2 * i], current_level[2 * i + 1]);
        }
        current_level = next_level;
        current_index /= 2;
    }
    Ok(proof)
}

pub fn compute_index_bits(index: u64, depth: usize) -> Vec<bool> {
    let mut bits = Vec::with_capacity(depth);
    for i in 0..depth {
        bits.push((index & (1u64 << i)) != 0);
    }
    bits
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merkle_root_single_leaf() {
        let leaf = [0xAA; 32];
        let root = compute_merkle_root(&[leaf], 4).unwrap();
        assert_ne!(root, ZERO_BYTES_32);
    }

    #[test]
    fn merkle_proof_verifies() {
        let leaf = compute_withdraw_leaf([0xBB; 32]);
        let leaves = vec![leaf];
        let root = compute_merkle_root(&leaves, WITHDRAW_TREE_DEPTH).unwrap();
        let proof = generate_merkle_proof(&leaves, 0, WITHDRAW_TREE_DEPTH).unwrap();
        assert_eq!(proof.len(), WITHDRAW_TREE_DEPTH);

        let mut current = leaf;
        let bits = compute_index_bits(0, WITHDRAW_TREE_DEPTH);
        for (sibling, bit) in proof.iter().zip(bits.iter()) {
            if *bit {
                current = compute_merkle_node_hash(*sibling, current);
            } else {
                current = compute_merkle_node_hash(current, *sibling);
            }
        }
        assert_eq!(current, root);
    }

    #[test]
    fn index_bits_roundtrip() {
        let bits = compute_index_bits(42, 16);
        assert_eq!(bits.len(), 16);
        let mut reconstructed = 0u64;
        for (i, &b) in bits.iter().enumerate() {
            if b {
                reconstructed |= 1u64 << i;
            }
        }
        assert_eq!(reconstructed, 42);
    }
}
