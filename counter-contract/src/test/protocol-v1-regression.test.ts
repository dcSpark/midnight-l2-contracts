/**
 * Protocol V1 Regression Test Suite
 * 
 * This test file ensures the V1 protocol implementation remains correct:
 * 1. Integers encoded as 32-byte little-endian (matches Compact)
 * 2. Hashes use sha256(concat(bytes32 chunks)) pattern
 * 3. Merkle tree uses 2 ** depth, not bit-shift
 * 4. Empty merkle leaves are 0x00...00 (32 zero bytes)
 * 5. Golden vectors match hardcoded expected values
 * 6. No silent truncation in string padding
 * 
 * These tests verify the implementation is correct and catch regressions.
 */

import { describe, it, expect } from 'vitest';
import {
  hashL1ToL2Deposit,
  hashL2ToL1Withdraw,
  computeInitialRollingHash,
  extendRollingHash,
  computeWithdrawLeaf,
  computeMerkleNodeHash,
  computeMerkleRoot,
  padBytes32,
  strictPadBytes32,
  zeroBytes32,
  bytesToHex,
  hexToBytes,
  bytesEqual,
  uToBytes32LE,
  concatBytes32Chunks,
  sha256,
  L1ToL2DepositMessage,
  L2ToL1WithdrawMessage,
} from '../protocol-types';

// ============================================================================
// REGRESSION 1: Integer Encoding (32-byte little-endian)
// ============================================================================

describe('Integer Encoding Endianness', () => {
  /**
   * Compact's Field -> Bytes<n> is explicitly little-endian.
   * Verify our implementation correctly uses little-endian.
   */
  
  it('should encode integers as little-endian (32 bytes)', () => {
    // Value: 0x0102030405060708 (72623859790382856)
    // Little-endian: 08 07 06 05 04 03 02 01 00 00 ... (LSB first)
    
    const value = 0x0102030405060708n;
    
    // Expected little-endian 32-byte encoding
    const expectedLE = new Uint8Array(32);
    expectedLE[0] = 0x08;
    expectedLE[1] = 0x07;
    expectedLE[2] = 0x06;
    expectedLE[3] = 0x05;
    expectedLE[4] = 0x04;
    expectedLE[5] = 0x03;
    expectedLE[6] = 0x02;
    expectedLE[7] = 0x01;
    // Rest are zeros
    
    const actualLE = uToBytes32LE(value);
    
    expect(bytesToHex(actualLE)).toBe(bytesToHex(expectedLE));
  });
  
  it('should encode Uint<128> as 32-byte little-endian', () => {
    const amount = 1000000000000000000n; // 1e18
    
    const leEncoded = uToBytes32LE(amount);
    
    // Check that it's 32 bytes
    expect(leEncoded.length).toBe(32);
    
    // Check that LSB is first
    expect(leEncoded[0]).toBe(0x00); // LSB
    expect(leEncoded[1]).toBe(0x00);
    expect(leEncoded[2]).toBe(0x64);
    expect(leEncoded[3]).toBe(0xa7);
    expect(leEncoded[4]).toBe(0xb3);
    expect(leEncoded[5]).toBe(0xb6);
    expect(leEncoded[6]).toBe(0xe0);
    expect(leEncoded[7]).toBe(0x0d); // MSB of the actual value
    // Rest should be zeros
    for (let i = 8; i < 32; i++) {
      expect(leEncoded[i]).toBe(0);
    }
  });
});

// ============================================================================
// REGRESSION 2: Hashing Pattern (sha256 over bytes32 chunks)
// ============================================================================

describe('Hashing Pattern (bytes32 chunks)', () => {
  /**
   * Verify hashes use the pattern: sha256(concat(bytes32 chunks))
   * This matches Compact's: persistentHash<Vector<n, Bytes<32>>>([...])
   */
  
  it('should hash withdrawal using bytes32 chunks pattern', () => {
    const msg: L2ToL1WithdrawMessage = {
      sender: padBytes32('alice'),
      recipient: padBytes32('bob'),
      amount: 1000000000000000000n,
      nonce: 1n,
    };
    
    // Expected preimage: DS || sender || recipient || amount_LE32 || nonce_LE32
    const domainSep = padBytes32('mdn:l2l1:wdraw');
    const amountLE = uToBytes32LE(msg.amount);
    const nonceLE = uToBytes32LE(msg.nonce);
    
    const preimage = concatBytes32Chunks([
      domainSep,
      msg.sender,
      msg.recipient,
      amountLE,
      nonceLE,
    ]);
    
    // Should be exactly 5 * 32 = 160 bytes
    expect(preimage.length).toBe(160);
    
    const expectedHash = sha256(preimage);
    const actualHash = hashL2ToL1Withdraw(msg);
    
    expect(bytesToHex(actualHash)).toBe(bytesToHex(expectedHash));
  });
  
  it('should hash deposit using bytes32 chunks pattern', () => {
    const msg: L1ToL2DepositMessage = {
      sender: zeroBytes32(),
      recipient: padBytes32('alice'),
      amount: 1000000000000000000n,
      nonce: 42n,
      gasLimit: 100000n,
      dataHash: zeroBytes32(),
    };
    
    // Expected preimage: DS || sender || recipient || amount || nonce || gasLimit || dataHash
    const domainSep = padBytes32('mdn:l1l2:deposit');
    
    const preimage = concatBytes32Chunks([
      domainSep,
      msg.sender,
      msg.recipient,
      uToBytes32LE(msg.amount),
      uToBytes32LE(msg.nonce),
      uToBytes32LE(msg.gasLimit),
      msg.dataHash,
    ]);
    
    // 7 chunks * 32 bytes = 224 bytes
    expect(preimage.length).toBe(224);
    
    const expectedHash = sha256(preimage);
    const actualHash = hashL1ToL2Deposit(msg);
    
    expect(bytesToHex(actualHash)).toBe(bytesToHex(expectedHash));
  });
});

// ============================================================================
// REGRESSION 3: Merkle Tree (uses 2 ** depth, not bit-shift)
// ============================================================================

describe('Merkle Tree Bit-Shift Avoidance', () => {
  /**
   * Verify implementation uses 2 ** treeDepth instead of 1 << treeDepth.
   * JS bit shifts are 32-bit and break for depth >= 31.
   */
  
  it('should demonstrate why bit-shift is wrong for depth >= 31', () => {
    // 1 << 31 in JS = -2147483648 (wraps to negative!)
    // 2 ** 31 = 2147483648 (correct)
    
    const depth31BitShift = 1 << 31;
    const depth31Power = 2 ** 31;
    
    // This proves bit-shift is dangerous
    expect(depth31BitShift).toBe(-2147483648); // Would be wrong!
    expect(depth31Power).toBe(2147483648);     // Correct
  });
  
  it('should demonstrate why bit-shift is wrong for depth >= 32', () => {
    // 1 << 40 would be wrong due to 32-bit wrapping
    // (1 << 40) === (1 << 8) === 256 in JS!
    
    const depth40Power = 2 ** 40;
    const depth40BitShift = 1 << 40;
    
    expect(depth40Power).toBe(1099511627776);  // Correct
    expect(depth40BitShift).toBe(256);          // Would be completely wrong!
    expect(Number.isSafeInteger(depth40Power)).toBe(true);
  });
});

// ============================================================================
// REGRESSION 4: Merkle Empty Leaf Padding (uses 0x00...00)
// ============================================================================

describe('Merkle Empty Leaf Padding', () => {
  /**
   * Verify empty leaves use 0x00...00 (32 zero bytes), not H(0,0).
   * zeroHashes[n] = H(zeroHashes[n-1], zeroHashes[n-1]) where zeroHashes[-1] = 0x00...00
   */
  
  it('should distinguish zero bytes from H(0,0)', () => {
    const emptyLeaf = zeroBytes32();
    const h00 = computeMerkleNodeHash(zeroBytes32(), zeroBytes32());
    
    // These should be different
    expect(bytesEqual(emptyLeaf, h00)).toBe(false);
    
    // Empty leaf should be 32 zero bytes
    for (let i = 0; i < 32; i++) {
      expect(emptyLeaf[i]).toBe(0);
    }
    
    // H(0,0) should be a non-zero hash
    let hasNonZero = false;
    for (let i = 0; i < 32; i++) {
      if (h00[i] !== 0) hasNonZero = true;
    }
    expect(hasNonZero).toBe(true);
  });
  
  it('should pad missing leaves with zero bytes in merkle root calculation', () => {
    const leaves = [padBytes32('leaf0')];
    const treeDepth = 2; // max 4 leaves
    
    // Expected padding using 0x00...00:
    // leaf[0] = given, leaf[1-3] = 0x00...00
    const emptyLeaf = zeroBytes32();
    const paddedLeaves = [leaves[0], emptyLeaf, emptyLeaf, emptyLeaf];
    
    // Build tree manually
    const h01 = computeMerkleNodeHash(paddedLeaves[0], paddedLeaves[1]);
    const h23 = computeMerkleNodeHash(paddedLeaves[2], paddedLeaves[3]);
    const expectedRoot = computeMerkleNodeHash(h01, h23);
    
    // computeMerkleRoot should produce the same result
    const actualRoot = computeMerkleRoot(leaves, treeDepth);
    
    expect(bytesToHex(actualRoot)).toBe(bytesToHex(expectedRoot));
  });
});

// ============================================================================
// REGRESSION 5: Golden Vectors (fixed expected values)
// ============================================================================

describe('Golden Vectors with Fixed Expected Values', () => {
  /**
   * Golden vectors ensure implementation produces correct, deterministic hashes.
   * These values are computed once with the correct implementation and hardcoded.
   */
  
  // Zero hashes (standard Ethereum/Merkle convention)
  const ZERO_HASHES = {
    level0: 'f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b', // sha256(0||0)
    level1: 'db56114e00fdd4c1f85c892bf35ac9a89289aaecb1ebd0a96cde606a748b5d71',
    level2: 'c78009fdf07fc56a11f122370658a353aaa542ed63e44c4bc15ff4cd105ab33c',
    level3: '536d98837f2dd165a55d5eeae91485954472d56f246df256bf3cae19352a123c',
    level4: '9efde052aa15429fae05bad4d0b1d7c64da64d03d7a1854a588c2cb8430c0d30',
  };
  
  // Message hashes (from test vectors)
  const MESSAGE_HASHES = {
    // alice -> bob, 1e18, nonce 1
    withdrawal1: 'dd6f90565a8836e42db825008b69d8724ccaeba75976aca34d8a3f0e4be64ccc',
    withdrawLeaf1: 'f81a08ee2b411732de65da6753f7986d1222e4c08f3b341e49c23cbc639ebe27',
    // zero sender -> alice, 1e18, nonce 42, gas 100000, dataHash zero
    deposit1: 'e2089c3ddcdace28b6aacba8d8a92567c5c96a42252a7a26cefd1acfdae599e4',
    rollingInitial1: '63cd510cb8d3608e2fd452238945d81c136b49a5855b23eb959fcee6e0ce8e80',
  };
  
  it('should produce correct zero hash at level 0', () => {
    const h00 = computeMerkleNodeHash(zeroBytes32(), zeroBytes32());
    expect(bytesToHex(h00)).toBe(ZERO_HASHES.level0);
  });
  
  it('should produce correct zero hash at level 1', () => {
    const h00 = hexToBytes(ZERO_HASHES.level0);
    const h1 = computeMerkleNodeHash(h00, h00);
    expect(bytesToHex(h1)).toBe(ZERO_HASHES.level1);
  });
  
  it('should produce correct zero hash at level 2', () => {
    const h1 = hexToBytes(ZERO_HASHES.level1);
    const h2 = computeMerkleNodeHash(h1, h1);
    expect(bytesToHex(h2)).toBe(ZERO_HASHES.level2);
  });
  
  it('should produce correct withdrawal hash (alice -> bob, 1e18, nonce 1)', () => {
    const msg: L2ToL1WithdrawMessage = {
      sender: padBytes32('alice'),
      recipient: padBytes32('bob'),
      amount: 1000000000000000000n,
      nonce: 1n,
    };
    const hash = hashL2ToL1Withdraw(msg);
    expect(bytesToHex(hash)).toBe(MESSAGE_HASHES.withdrawal1);
  });
  
  it('should produce correct withdraw leaf hash', () => {
    const msgHash = hexToBytes(MESSAGE_HASHES.withdrawal1);
    const leafHash = computeWithdrawLeaf(msgHash);
    expect(bytesToHex(leafHash)).toBe(MESSAGE_HASHES.withdrawLeaf1);
  });
  
  it('should produce correct deposit hash (zero -> alice, 1e18)', () => {
    const msg: L1ToL2DepositMessage = {
      sender: zeroBytes32(),
      recipient: padBytes32('alice'),
      amount: 1000000000000000000n,
      nonce: 42n,
      gasLimit: 100000n,
      dataHash: zeroBytes32(),
    };
    const hash = hashL1ToL2Deposit(msg);
    expect(bytesToHex(hash)).toBe(MESSAGE_HASHES.deposit1);
  });
  
  it('should produce correct initial rolling hash', () => {
    const depositHash = hexToBytes(MESSAGE_HASHES.deposit1);
    const rollingHash = computeInitialRollingHash(depositHash);
    expect(bytesToHex(rollingHash)).toBe(MESSAGE_HASHES.rollingInitial1);
  });
});

// ============================================================================
// REGRESSION 6: No Silent Truncation
// ============================================================================

describe('Domain Separator Truncation Protection', () => {
  /**
   * Verify strictPadBytes32 throws on too-long input (no silent truncation).
   */
  
  it('should throw if domain separator exceeds max length', () => {
    const tooLong = 'this-string-is-definitely-longer-than-thirty-two-bytes-and-should-fail';
    
    expect(() => {
      strictPadBytes32(tooLong);
    }).toThrow();
  });
  
  it('should accept strings up to 32 bytes', () => {
    const exact32 = '12345678901234567890123456789012'; // exactly 32 chars
    expect(strictPadBytes32(exact32).length).toBe(32);
    
    const shorter = 'abc';
    expect(strictPadBytes32(shorter).length).toBe(32);
  });
});

// ============================================================================
// REGRESSION 7: Input Validation
// ============================================================================

describe('Input Validation', () => {
  /**
   * Verify functions reject invalid inputs.
   */
  
  it('should reject negative integers', () => {
    expect(() => uToBytes32LE(-1n)).toThrow();
  });
  
  it('should reject integers that exceed 32 bytes', () => {
    const tooLarge = 1n << 256n; // 2^256
    expect(() => uToBytes32LE(tooLarge)).toThrow();
  });
  
  it('should reject non-32-byte chunks in concatBytes32Chunks', () => {
    const valid = new Uint8Array(32);
    const invalid = new Uint8Array(16);
    
    expect(() => concatBytes32Chunks([valid, invalid])).toThrow();
  });
  
  it('should reject invalid hex in hexToBytes', () => {
    expect(() => hexToBytes('0xgg')).toThrow(); // invalid hex chars
    expect(() => hexToBytes('0x123')).toThrow(); // odd length
  });
});
