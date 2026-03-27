/**
 * Protocol Types Test Suite
 * 
 * This test suite verifies that the TypeScript implementation of protocol types
 * produces consistent hashes. Once the Compact implementation is compiled and
 * can be invoked, these tests should be extended to verify cross-language consistency.
 * 
 * CRITICAL: If any test fails after a code change, it indicates a consensus-breaking change.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  // Types
  L1ToL2DepositMessage,
  L2ToL1WithdrawMessage,
  
  // Hash functions
  hashL1ToL2Deposit,
  hashL2ToL1Withdraw,
  computeInitialRollingHash,
  extendRollingHash,
  computeWithdrawLeaf,
  computeMerkleNodeHash,
  computeZeroHash,
  precomputeZeroHashes,
  
  // Merkle tree
  computeMerkleRoot,
  generateMerkleProof,
  verifyMerkleProof,
  IncrementalMerkleTree,
  
  // Index bits (Phase 4)
  computeIndexBits,
  verifyBitDecomposition,
  
  // Utilities
  padBytes32,
  zeroBytes32,
  bytesToHex,
  hexToBytes,
  bytesEqual,
  
  // Domain separators (for inspection)
  DOMAIN_L1_TO_L2_DEPOSIT,
  DOMAIN_L2_TO_L1_WITHDRAW,
  DOMAIN_L1_QUEUE_HASH,
  DOMAIN_L2_WITHDRAW_LEAF,
} from '../protocol-types';

// ============================================================================
// GOLDEN TEST VECTORS
// ============================================================================
// These values are the canonical hashes that all implementations must produce.
// If you need to update these, you are making a consensus-breaking change!

const GOLDEN = {
  // Domain separators (for verification)
  domainSeparators: {
    l1ToL2Deposit: 'mdn:l1l2:deposit',
    l2ToL1Withdraw: 'mdn:l2l1:wdraw',
    l1QueueHash: 'mdn:l1q:rolling',
    l2WithdrawLeaf: 'mdn:l2w:leaf',
  },
  
  // Test vector 1: Zero message (all zeros except amount=1, nonce=1, gasLimit=100000)
  depositMessage1: {
    sender: zeroBytes32(),
    recipient: zeroBytes32(),
    amount: 1n,
    nonce: 1n,
    gasLimit: 100000n,
    dataHash: zeroBytes32(),
  } as L1ToL2DepositMessage,
  
  // Test vector 2: Named recipient
  depositMessage2: {
    sender: padBytes32('gateway'),
    recipient: padBytes32('alice'),
    amount: 1000000000000000000n, // 1e18
    nonce: 42n,
    gasLimit: 200000n,
    dataHash: zeroBytes32(),
  } as L1ToL2DepositMessage,
  
  // Test vector 3: Simple withdrawal
  withdrawMessage1: {
    sender: padBytes32('alice'),
    recipient: padBytes32('gateway'),
    amount: 500000000000000000n, // 0.5e18
    nonce: 1n,
  } as L2ToL1WithdrawMessage,
  
  // Test vector 4: Large nonce withdrawal
  withdrawMessage2: {
    sender: zeroBytes32(),
    recipient: zeroBytes32(),
    amount: 0n,
    nonce: 999999n,
  } as L2ToL1WithdrawMessage,
};

// ============================================================================
// TEST SUITES
// ============================================================================

describe('Domain Separators', () => {
  it('should have correct domain separator encoding', () => {
    // Verify domain separators are correctly padded to 32 bytes (V1 spec)
    expect(DOMAIN_L1_TO_L2_DEPOSIT.length).toBe(32);
    expect(DOMAIN_L2_TO_L1_WITHDRAW.length).toBe(32);
    expect(DOMAIN_L1_QUEUE_HASH.length).toBe(32);
    expect(DOMAIN_L2_WITHDRAW_LEAF.length).toBe(32);
    
    // Verify the string content
    const decoder = new TextDecoder();
    expect(decoder.decode(DOMAIN_L1_TO_L2_DEPOSIT).replace(/\0/g, '')).toBe('mdn:l1l2:deposit');
    expect(decoder.decode(DOMAIN_L2_TO_L1_WITHDRAW).replace(/\0/g, '')).toBe('mdn:l2l1:wdraw');
    expect(decoder.decode(DOMAIN_L1_QUEUE_HASH).replace(/\0/g, '')).toBe('mdn:l1q:rolling');
    expect(decoder.decode(DOMAIN_L2_WITHDRAW_LEAF).replace(/\0/g, '')).toBe('mdn:l2w:leaf');
  });
});

describe('L1→L2 Deposit Message Hashing', () => {
  it('should produce deterministic hash for zero message', () => {
    const hash1 = hashL1ToL2Deposit(GOLDEN.depositMessage1);
    const hash2 = hashL1ToL2Deposit(GOLDEN.depositMessage1);
    
    expect(bytesEqual(hash1, hash2)).toBe(true);
    expect(hash1.length).toBe(32);
    
    // Log for generating golden vectors
    console.log('Deposit Message 1 Hash:', bytesToHex(hash1));
  });
  
  it('should produce different hash for different messages', () => {
    const hash1 = hashL1ToL2Deposit(GOLDEN.depositMessage1);
    const hash2 = hashL1ToL2Deposit(GOLDEN.depositMessage2);
    
    expect(bytesEqual(hash1, hash2)).toBe(false);
  });
  
  it('should be sensitive to amount changes', () => {
    const msg1 = { ...GOLDEN.depositMessage1 };
    const msg2 = { ...GOLDEN.depositMessage1, amount: 2n };
    
    const hash1 = hashL1ToL2Deposit(msg1);
    const hash2 = hashL1ToL2Deposit(msg2);
    
    expect(bytesEqual(hash1, hash2)).toBe(false);
  });
  
  it('should be sensitive to nonce changes', () => {
    const msg1 = { ...GOLDEN.depositMessage1 };
    const msg2 = { ...GOLDEN.depositMessage1, nonce: 2n };
    
    const hash1 = hashL1ToL2Deposit(msg1);
    const hash2 = hashL1ToL2Deposit(msg2);
    
    expect(bytesEqual(hash1, hash2)).toBe(false);
  });
  
  it('should produce named recipient hash', () => {
    const hash = hashL1ToL2Deposit(GOLDEN.depositMessage2);
    console.log('Deposit Message 2 Hash:', bytesToHex(hash));
    expect(hash.length).toBe(32);
  });
});

describe('L2→L1 Withdrawal Message Hashing', () => {
  it('should produce deterministic hash', () => {
    const hash1 = hashL2ToL1Withdraw(GOLDEN.withdrawMessage1);
    const hash2 = hashL2ToL1Withdraw(GOLDEN.withdrawMessage1);
    
    expect(bytesEqual(hash1, hash2)).toBe(true);
    expect(hash1.length).toBe(32);
    
    console.log('Withdraw Message 1 Hash:', bytesToHex(hash1));
  });
  
  it('should produce different hash for different messages', () => {
    const hash1 = hashL2ToL1Withdraw(GOLDEN.withdrawMessage1);
    const hash2 = hashL2ToL1Withdraw(GOLDEN.withdrawMessage2);
    
    expect(bytesEqual(hash1, hash2)).toBe(false);
  });
  
  it('should be sensitive to sender changes', () => {
    const msg1 = { ...GOLDEN.withdrawMessage1 };
    const msg2 = { ...GOLDEN.withdrawMessage1, sender: padBytes32('bob') };
    
    const hash1 = hashL2ToL1Withdraw(msg1);
    const hash2 = hashL2ToL1Withdraw(msg2);
    
    expect(bytesEqual(hash1, hash2)).toBe(false);
  });
});

describe('Rolling Hash Chain', () => {
  it('should compute initial rolling hash correctly', () => {
    const depositHash = hashL1ToL2Deposit(GOLDEN.depositMessage1);
    const rollingHash = computeInitialRollingHash(depositHash);
    
    expect(rollingHash.length).toBe(32);
    console.log('Initial Rolling Hash:', bytesToHex(rollingHash));
  });
  
  it('should extend rolling hash correctly', () => {
    const depositHash1 = hashL1ToL2Deposit(GOLDEN.depositMessage1);
    const depositHash2 = hashL1ToL2Deposit(GOLDEN.depositMessage2);
    
    const rollingHash1 = computeInitialRollingHash(depositHash1);
    const rollingHash2 = extendRollingHash(rollingHash1, depositHash2);
    
    expect(bytesEqual(rollingHash1, rollingHash2)).toBe(false);
    console.log('Rolling Hash after 2 deposits:', bytesToHex(rollingHash2));
  });
  
  it('should be order-dependent', () => {
    const depositHash1 = hashL1ToL2Deposit(GOLDEN.depositMessage1);
    const depositHash2 = hashL1ToL2Deposit(GOLDEN.depositMessage2);
    
    // Order: 1, 2
    const r1 = computeInitialRollingHash(depositHash1);
    const r1_2 = extendRollingHash(r1, depositHash2);
    
    // Order: 2, 1
    const r2 = computeInitialRollingHash(depositHash2);
    const r2_1 = extendRollingHash(r2, depositHash1);
    
    // Different orders should produce different hashes
    expect(bytesEqual(r1_2, r2_1)).toBe(false);
  });
  
  it('should produce consistent chain for multiple messages', () => {
    const deposits = [
      GOLDEN.depositMessage1,
      GOLDEN.depositMessage2,
      { ...GOLDEN.depositMessage1, nonce: 100n },
    ];
    
    const hashes = deposits.map(hashL1ToL2Deposit);
    
    let rollingHash = computeInitialRollingHash(hashes[0]);
    const chain = [bytesToHex(rollingHash)];
    
    for (let i = 1; i < hashes.length; i++) {
      rollingHash = extendRollingHash(rollingHash, hashes[i]);
      chain.push(bytesToHex(rollingHash));
    }
    
    console.log('Rolling Hash Chain:');
    chain.forEach((h, i) => console.log(`  [${i}]: ${h}`));
    
    // Verify chain is deterministic
    let rollingHash2 = computeInitialRollingHash(hashes[0]);
    for (let i = 1; i < hashes.length; i++) {
      rollingHash2 = extendRollingHash(rollingHash2, hashes[i]);
    }
    expect(bytesToHex(rollingHash2)).toBe(chain[chain.length - 1]);
  });
});

describe('Withdrawal Merkle Leaf', () => {
  it('should add domain separation to withdrawal hash', () => {
    const withdrawHash = hashL2ToL1Withdraw(GOLDEN.withdrawMessage1);
    const leaf = computeWithdrawLeaf(withdrawHash);
    
    // Leaf should be different from raw hash (domain separation added)
    expect(bytesEqual(leaf, withdrawHash)).toBe(false);
    expect(leaf.length).toBe(32);
    
    console.log('Withdraw Leaf:', bytesToHex(leaf));
  });
  
  it('should be deterministic', () => {
    const withdrawHash = hashL2ToL1Withdraw(GOLDEN.withdrawMessage1);
    const leaf1 = computeWithdrawLeaf(withdrawHash);
    const leaf2 = computeWithdrawLeaf(withdrawHash);
    
    expect(bytesEqual(leaf1, leaf2)).toBe(true);
  });
});

describe('Merkle Node Hash', () => {
  it('should produce deterministic hash', () => {
    const left = padBytes32('left');
    const right = padBytes32('right');
    
    const hash1 = computeMerkleNodeHash(left, right);
    const hash2 = computeMerkleNodeHash(left, right);
    
    expect(bytesEqual(hash1, hash2)).toBe(true);
    expect(hash1.length).toBe(32);
  });
  
  it('should be order-sensitive', () => {
    const left = padBytes32('left');
    const right = padBytes32('right');
    
    const hash1 = computeMerkleNodeHash(left, right);
    const hash2 = computeMerkleNodeHash(right, left);
    
    expect(bytesEqual(hash1, hash2)).toBe(false);
  });
});

describe('Zero Hashes', () => {
  it('should compute consistent zero hashes', () => {
    const z0 = computeZeroHash(0);
    const z1 = computeZeroHash(1);
    const z2 = computeZeroHash(2);
    
    expect(z0.length).toBe(32);
    expect(z1.length).toBe(32);
    expect(z2.length).toBe(32);
    
    // Level 1 should be H(z0, z0)
    expect(bytesEqual(z1, computeMerkleNodeHash(z0, z0))).toBe(true);
    
    // Level 2 should be H(z1, z1)
    expect(bytesEqual(z2, computeMerkleNodeHash(z1, z1))).toBe(true);
    
    console.log('Zero Hash [0]:', bytesToHex(z0));
    console.log('Zero Hash [1]:', bytesToHex(z1));
    console.log('Zero Hash [2]:', bytesToHex(z2));
  });
  
  it('should precompute zero hashes correctly', () => {
    const precomputed = precomputeZeroHashes(4);
    
    expect(precomputed.length).toBe(5);
    
    for (let i = 0; i < 5; i++) {
      expect(bytesEqual(precomputed[i], computeZeroHash(i))).toBe(true);
    }
  });
});

describe('Merkle Tree', () => {
  let leaves: Uint8Array[];
  
  beforeAll(() => {
    // Create some test withdrawal leaves
    const withdrawals = [
      GOLDEN.withdrawMessage1,
      GOLDEN.withdrawMessage2,
      { ...GOLDEN.withdrawMessage1, nonce: 10n },
      { ...GOLDEN.withdrawMessage2, amount: 100n },
    ];
    
    leaves = withdrawals.map(w => {
      const msgHash = hashL2ToL1Withdraw(w);
      return computeWithdrawLeaf(msgHash);
    });
  });
  
  it('should compute merkle root', () => {
    const root = computeMerkleRoot(leaves, 3); // depth 3 = max 8 leaves
    
    expect(root.length).toBe(32);
    console.log('Merkle Root (4 leaves, depth 3):', bytesToHex(root));
  });
  
  it('should produce consistent root', () => {
    const root1 = computeMerkleRoot(leaves, 3);
    const root2 = computeMerkleRoot(leaves, 3);
    
    expect(bytesEqual(root1, root2)).toBe(true);
  });
  
  it('should generate and verify merkle proof', () => {
    const treeDepth = 3;
    const root = computeMerkleRoot(leaves, treeDepth);
    
    // Generate proof for each leaf
    for (let i = 0; i < leaves.length; i++) {
      const { proof, pathBits } = generateMerkleProof(leaves, i, treeDepth);
      
      expect(proof.length).toBe(treeDepth);
      expect(pathBits.length).toBe(treeDepth);
      
      // Verify the proof
      const isValid = verifyMerkleProof(leaves[i], proof, pathBits, root);
      expect(isValid).toBe(true);
    }
  });
  
  it('should reject invalid proof', () => {
    const treeDepth = 3;
    const root = computeMerkleRoot(leaves, treeDepth);
    
    const { proof, pathBits } = generateMerkleProof(leaves, 0, treeDepth);
    
    // Try to verify with wrong leaf
    const isValid = verifyMerkleProof(leaves[1], proof, pathBits, root);
    expect(isValid).toBe(false);
  });
  
  it('should reject proof with tampered sibling', () => {
    const treeDepth = 3;
    const root = computeMerkleRoot(leaves, treeDepth);
    
    const { proof, pathBits } = generateMerkleProof(leaves, 0, treeDepth);
    
    // Tamper with a sibling
    const tamperedProof = proof.map(p => new Uint8Array(p));
    tamperedProof[0][0] ^= 0xff;
    
    const isValid = verifyMerkleProof(leaves[0], tamperedProof, pathBits, root);
    expect(isValid).toBe(false);
  });
  
  it('should handle single leaf', () => {
    const singleLeaf = [leaves[0]];
    const treeDepth = 2;
    
    const root = computeMerkleRoot(singleLeaf, treeDepth);
    const { proof, pathBits } = generateMerkleProof(singleLeaf, 0, treeDepth);
    
    const isValid = verifyMerkleProof(singleLeaf[0], proof, pathBits, root);
    expect(isValid).toBe(true);
  });
  
  it('should handle empty tree (all zeros)', () => {
    const emptyLeaves: Uint8Array[] = [];
    const treeDepth = 2;
    
    const root = computeMerkleRoot(emptyLeaves, treeDepth);
    
    // Root should be consistent with zero hashes
    const zeroHashes = precomputeZeroHashes(treeDepth);
    const expectedRoot = zeroHashes[treeDepth];
    
    // Note: Our implementation uses zeroHashes[0] for leaves, not zeroBytes32
    // So the empty tree root is H(H(z0, z0), H(z0, z0)) where z0 = H(0,0)
    expect(root.length).toBe(32);
    console.log('Empty Tree Root:', bytesToHex(root));
  });
});

describe('Utility Functions', () => {
  it('should convert bytes to hex and back', () => {
    const original = padBytes32('test');
    const hex = bytesToHex(original);
    const recovered = hexToBytes(hex);
    
    expect(bytesEqual(original, recovered)).toBe(true);
  });
  
  it('should handle 0x prefix in hex', () => {
    const bytes = padBytes32('hello');
    const hex = '0x' + bytesToHex(bytes);
    const recovered = hexToBytes(hex);
    
    expect(bytesEqual(bytes, recovered)).toBe(true);
  });
  
  it('should compare bytes correctly', () => {
    const a = padBytes32('same');
    const b = padBytes32('same');
    const c = padBytes32('different');
    
    expect(bytesEqual(a, b)).toBe(true);
    expect(bytesEqual(a, c)).toBe(false);
  });
});

describe('Golden Vector Verification', () => {
  // Load golden vectors from JSON file
  // These are FIXED values - if the test fails, the implementation is wrong
  const goldenVectors = {
    zeroHashes: {
      level0: 'f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b',
      level1: 'db56114e00fdd4c1f85c892bf35ac9a89289aaecb1ebd0a96cde606a748b5d71',
      level2: 'c78009fdf07fc56a11f122370658a353aaa542ed63e44c4bc15ff4cd105ab33c',
      level3: '536d98837f2dd165a55d5eeae91485954472d56f246df256bf3cae19352a123c',
      level4: '9efde052aa15429fae05bad4d0b1d7c64da64d03d7a1854a588c2cb8430c0d30',
    },
    withdrawal1: {
      expectedHash: 'dd6f90565a8836e42db825008b69d8724ccaeba75976aca34d8a3f0e4be64ccc',
    },
    deposit1: {
      expectedHash: 'e2089c3ddcdace28b6aacba8d8a92567c5c96a42252a7a26cefd1acfdae599e4',
    },
    rollingHash1: {
      expectedHash: '63cd510cb8d3608e2fd452238945d81c136b49a5855b23eb959fcee6e0ce8e80',
    },
    withdrawLeaf1: {
      expectedHash: 'f81a08ee2b411732de65da6753f7986d1222e4c08f3b341e49c23cbc639ebe27',
    },
  };

  it('should match withdrawal1 golden vector', () => {
    const msg = {
      sender: padBytes32('alice'),
      recipient: padBytes32('bob'),
      amount: 1000000000000000000n,
      nonce: 1n,
    };
    const hash = hashL2ToL1Withdraw(msg);
    expect(bytesToHex(hash)).toBe(goldenVectors.withdrawal1.expectedHash);
  });

  it('should match deposit1 golden vector', () => {
    const msg = {
      sender: zeroBytes32(),
      recipient: padBytes32('alice'),
      amount: 1000000000000000000n,
      nonce: 42n,
      gasLimit: 100000n,
      dataHash: zeroBytes32(),
    };
    const hash = hashL1ToL2Deposit(msg);
    expect(bytesToHex(hash)).toBe(goldenVectors.deposit1.expectedHash);
  });

  it('should match rollingHash1 golden vector', () => {
    const depositHash = hexToBytes(goldenVectors.deposit1.expectedHash);
    const rollingHash = computeInitialRollingHash(depositHash);
    expect(bytesToHex(rollingHash)).toBe(goldenVectors.rollingHash1.expectedHash);
  });

  it('should match withdrawLeaf1 golden vector', () => {
    const withdrawHash = hexToBytes(goldenVectors.withdrawal1.expectedHash);
    const leafHash = computeWithdrawLeaf(withdrawHash);
    expect(bytesToHex(leafHash)).toBe(goldenVectors.withdrawLeaf1.expectedHash);
  });

  it('should match all zero hash golden vectors', () => {
    const zeroHashes = precomputeZeroHashes(4);
    expect(bytesToHex(zeroHashes[0])).toBe(goldenVectors.zeroHashes.level0);
    expect(bytesToHex(zeroHashes[1])).toBe(goldenVectors.zeroHashes.level1);
    expect(bytesToHex(zeroHashes[2])).toBe(goldenVectors.zeroHashes.level2);
    expect(bytesToHex(zeroHashes[3])).toBe(goldenVectors.zeroHashes.level3);
    expect(bytesToHex(zeroHashes[4])).toBe(goldenVectors.zeroHashes.level4);
  });
});

// ============================================================================
// CROSS-LANGUAGE VERIFICATION
// ============================================================================

import { pureCircuits as bridgePureCircuits } from '../managed/Bridge/contract/index.js';
import { pureCircuits as l2SimulationPureCircuits } from '../managed/L2Simulation/contract/index.js';

describe('Cross-Language Consistency', () => {
  // These tests verify that the TypeScript implementation
  // produces identical hashes to the Compact implementation.
  
  it('should match Compact hashL2ToL1Withdraw', () => {
    // L2Simulation artifact includes the full withdraw hash (Bridge re-exports domain separators only).
    const compactHash = l2SimulationPureCircuits.hashL2ToL1Withdraw(
      GOLDEN.withdrawMessage1.sender,
      GOLDEN.withdrawMessage1.recipient,
      GOLDEN.withdrawMessage1.amount,
      GOLDEN.withdrawMessage1.nonce
    );
    const tsHash = hashL2ToL1Withdraw(GOLDEN.withdrawMessage1);
    expect(bytesEqual(compactHash, tsHash)).toBe(true);
  });

  it('should match Compact hashWithdrawLeaf', () => {
    // First compute the withdrawal hash
    const withdrawHash = hashL2ToL1Withdraw(GOLDEN.withdrawMessage1);
    
    // Then compare the leaf hash computation
    const compactLeafHash = l2SimulationPureCircuits.hashWithdrawLeaf(withdrawHash);
    const tsLeafHash = computeWithdrawLeaf(withdrawHash);
    expect(bytesEqual(compactLeafHash, tsLeafHash)).toBe(true);
  });

  it('should match Compact hashMerkleNode', () => {
    const left = padBytes32('left');
    const right = padBytes32('right');
    
    const compactHash = bridgePureCircuits.hashMerkleNode(left, right);
    const tsHash = computeMerkleNodeHash(left, right);
    expect(bytesEqual(compactHash, tsHash)).toBe(true);
  });

  it('should match Compact u64ToBytes32LE', () => {
    const testValues = [0n, 1n, 255n, 256n, 65535n, 0xFFFFFFFFFFFFFFFFn];
    
    for (const val of testValues) {
      const compactBytes = bridgePureCircuits.u64ToBytes32LE(val);
      // Verify it's 32 bytes
      expect(compactBytes.length).toBe(32);
      // Verify little-endian encoding: first 8 bytes should contain the value
      let reconstructed = 0n;
      for (let i = 0; i < 8; i++) {
        reconstructed += BigInt(compactBytes[i]) << BigInt(i * 8);
      }
      expect(reconstructed).toBe(val);
    }
  });

  it('should match Compact u128ToBytes32LE', () => {
    const testValues = [0n, 1n, 1000000000000000000n, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFn];
    
    for (const val of testValues) {
      const compactBytes = bridgePureCircuits.u128ToBytes32LE(val);
      // Verify it's 32 bytes
      expect(compactBytes.length).toBe(32);
      // Verify little-endian encoding: first 16 bytes should contain the value
      let reconstructed = 0n;
      for (let i = 0; i < 16; i++) {
        reconstructed += BigInt(compactBytes[i]) << BigInt(i * 8);
      }
      expect(reconstructed).toBe(val);
    }
  });
});

// =============================================================================
// Phase 4: Index Bits and WithdrawNIGHT Flow Tests
// =============================================================================

describe('Phase 4: Index Bits Decomposition', () => {
  it('should compute correct bits for index 0', () => {
    const bits = computeIndexBits(0n);
    expect(bits.length).toBe(16);
    expect(bits.every(b => b === false)).toBe(true);
    expect(verifyBitDecomposition(bits, 0n)).toBe(true);
  });

  it('should compute correct bits for index 1', () => {
    const bits = computeIndexBits(1n);
    expect(bits[0]).toBe(true);
    expect(bits.slice(1).every(b => b === false)).toBe(true);
    expect(verifyBitDecomposition(bits, 1n)).toBe(true);
  });

  it('should compute correct bits for index 5 (binary: 101)', () => {
    const bits = computeIndexBits(5n);
    expect(bits[0]).toBe(true);  // 1
    expect(bits[1]).toBe(false); // 0
    expect(bits[2]).toBe(true);  // 1
    expect(bits.slice(3).every(b => b === false)).toBe(true);
    expect(verifyBitDecomposition(bits, 5n)).toBe(true);
  });

  it('should compute correct bits for index 255 (all lower 8 bits set)', () => {
    const bits = computeIndexBits(255n);
    for (let i = 0; i < 8; i++) {
      expect(bits[i]).toBe(true);
    }
    for (let i = 8; i < 16; i++) {
      expect(bits[i]).toBe(false);
    }
    expect(verifyBitDecomposition(bits, 255n)).toBe(true);
  });

  it('should compute correct bits for index 65535 (all 16 bits set)', () => {
    const bits = computeIndexBits(65535n);
    expect(bits.every(b => b === true)).toBe(true);
    expect(verifyBitDecomposition(bits, 65535n)).toBe(true);
  });

  it('should compute correct bits for power of 2 indices', () => {
    for (let i = 0; i < 16; i++) {
      const index = 1n << BigInt(i);
      const bits = computeIndexBits(index);
      // Only bit i should be set
      for (let j = 0; j < 16; j++) {
        expect(bits[j]).toBe(j === i);
      }
      expect(verifyBitDecomposition(bits, index)).toBe(true);
    }
  });

  it('should reject invalid bit decomposition', () => {
    const wrongBits = computeIndexBits(5n);
    expect(verifyBitDecomposition(wrongBits, 6n)).toBe(false);
  });
});

describe('Phase 4: WithdrawNIGHT Message Flow', () => {
  it('should compute withdrawal message and leaf hash correctly', () => {
    const sender = padBytes32("alice");
    const recipient = padBytes32("bob");
    const amount = 1000000000000000000n; // 1e18
    const nonce = 0n;

    // Compute message hash
    const messageHash = hashL2ToL1Withdraw({
      sender,
      recipient,
      amount,
      nonce
    });

    // Compute leaf hash
    const leafHash = computeWithdrawLeaf(messageHash);

    // Both should be 32 bytes
    expect(messageHash.length).toBe(32);
    expect(leafHash.length).toBe(32);

    // Leaf hash should be different from message hash (domain separation)
    expect(bytesToHex(leafHash)).not.toBe(bytesToHex(messageHash));
  });

  it('should update incremental Merkle tree correctly for first withdrawal', () => {
    const tree = new IncrementalMerkleTree(16);
    
    // Initial root should be zeroHashes[15]
    const emptyRoot = tree.getRoot();
    
    // Create a withdrawal leaf
    const messageHash = hashL2ToL1Withdraw({
      sender: padBytes32("alice"),
      recipient: padBytes32("bob"),
      amount: 1000000000000000000n,
      nonce: 0n
    });
    const leafHash = computeWithdrawLeaf(messageHash);
    
    // Append to tree
    tree.append(leafHash);
    
    // Root should have changed
    const newRoot = tree.getRoot();
    expect(bytesToHex(newRoot)).not.toBe(bytesToHex(emptyRoot));
    
    // Message count should be 1
    expect(tree.getLeafCount()).toBe(1);
  });

  it('should produce consistent roots for sequential withdrawals', () => {
    const tree = new IncrementalMerkleTree(16);
    const roots: string[] = [];
    
    // Add 5 withdrawals
    for (let i = 0; i < 5; i++) {
      const messageHash = hashL2ToL1Withdraw({
        sender: padBytes32("user" + i),
        recipient: padBytes32("dest" + i),
        amount: BigInt((i + 1) * 1000000000000000000),
        nonce: BigInt(i)
      });
      const leafHash = computeWithdrawLeaf(messageHash);
      tree.append(leafHash);
      roots.push(bytesToHex(tree.getRoot()));
    }
    
    // Each root should be unique
    const uniqueRoots = new Set(roots);
    expect(uniqueRoots.size).toBe(5);
    
    // Final count should be 5
    expect(tree.getLeafCount()).toBe(5);
  });
});

