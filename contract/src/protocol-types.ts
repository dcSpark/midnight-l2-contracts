/**
 * Protocol Types for L1 ↔ L2 Cross-Domain Messaging (V1)
 *
 * This file defines the canonical message formats and hashing functions
 * that MUST be identical across all implementations (Compact, TypeScript, Solidity).
 *
 * CRITICAL DESIGN DECISIONS:
 * 1. All hashes are: sha256(concat(bytes32 chunks))
 * 2. All integers are encoded as 32-byte LITTLE-ENDIAN (matches Compact Field -> Bytes<n>)
 * 3. Domain separators are 32 bytes (padded with zeros)
 * 4. Empty merkle leaves are 0x00...00 (32 zero bytes)
 *
 * CONSENSUS CRITICAL: Any change to these types or hash functions is a breaking change.
 */

import { createHash } from "crypto";
import { Buffer } from "buffer";

// ============================================================================
// DOMAIN SEPARATORS (32 bytes each)
// ============================================================================
// Must match Compact's pad(32, "...") exactly

export const DS_L1_TO_L2_DEPOSIT = strictPadBytes32("mdn:l1l2:deposit");
export const DS_L2_TO_L1_WITHDRAW = strictPadBytes32("mdn:l2l1:wdraw");
export const DS_L1_QUEUE_ROLLING = strictPadBytes32("mdn:l1q:rolling");
export const DS_L2_WITHDRAW_LEAF = strictPadBytes32("mdn:l2w:leaf");

// NOTE: DS_MERKLE_NODE is intentionally NOT defined for V1.
// Merkle node hashing uses raw H(left || right) without domain separation
// to match standard merkle tree implementations.

// Legacy exports (for backwards compatibility with existing tests)
export const DOMAIN_L1_TO_L2_DEPOSIT = DS_L1_TO_L2_DEPOSIT;
export const DOMAIN_L2_TO_L1_WITHDRAW = DS_L2_TO_L1_WITHDRAW;
export const DOMAIN_L1_QUEUE_HASH = DS_L1_QUEUE_ROLLING;
export const DOMAIN_L2_WITHDRAW_LEAF = DS_L2_WITHDRAW_LEAF;

// Phase 7: Batch public data domain separator
const DS_BATCH_PUBLIC_DATA = "mdn:batch:v1";
export const DOMAIN_BATCH_PUBLIC_DATA = DS_BATCH_PUBLIC_DATA;

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * L1 → L2 Deposit Message
 *
 * Created on L1 when user deposits NIGHT via NIGHTGateway.
 * Executed on L2 by L2Messenger.relayMessage() → L2NIGHTGateway.finalizeDeposit()
 */
export interface L1ToL2DepositMessage {
  /** The L1 sender address (32 bytes) */
  sender: Uint8Array;
  /** The L2 recipient address (32 bytes) */
  recipient: Uint8Array;
  /** Amount of NIGHT being deposited (128-bit unsigned integer) */
  amount: bigint;
  /** Unique message nonce assigned by L1MessageQueue (64-bit unsigned integer) */
  nonce: bigint;
  /** L2 gas limit for execution (64-bit unsigned integer) */
  gasLimit: bigint;
  /** Hash of optional calldata for L2 recipient (32 bytes, zero for simple deposits) */
  dataHash: Uint8Array;
}

/**
 * L2 → L1 Withdrawal Message
 *
 * Created on L2 when user calls withdrawNIGHT() via L2NIGHTGateway.
 * Verified on L1 via merkle proof in L1Messenger.relayMessageWithProof()
 */
export interface L2ToL1WithdrawMessage {
  /** The L2 sender address (32 bytes) */
  sender: Uint8Array;
  /** The L1 recipient address (32 bytes) */
  recipient: Uint8Array;
  /** Amount of NIGHT being withdrawn (128-bit unsigned integer) */
  amount: bigint;
  /** Unique message nonce assigned by L2MessageQueue (64-bit unsigned integer) */
  nonce: bigint;
}

/**
 * Batch Public Data V1 (for oracle signature verification)
 * 
 * This is the minimal batch commitment that the oracle network signs.
 * It includes everything needed for L1 to verify batch finalization.
 */
export interface BatchPublicDataV1 {
  /** Monotonically increasing batch number (64-bit unsigned integer) */
  batchIndex: bigint;
  /** State root before this batch (32 bytes) */
  prevStateRoot: Uint8Array;
  /** State root after this batch (32 bytes) */
  postStateRoot: Uint8Array;
  /** Merkle root of withdrawals in this batch (32 bytes) */
  withdrawRoot: Uint8Array;
  /** Rolling hash of processed L1→L2 messages (32 bytes) */
  l1MessageQueueHash: Uint8Array;
  /** Last processed L1 message queue index (64-bit unsigned integer) */
  lastL1MessageIndex: bigint;
}

/**
 * Batch Public Data (extended - for prover/verifier coordination)
 * 
 * This is the full batch public data used internally.
 * BatchPublicDataV1 is the minimal version signed by oracles.
 */
export interface BatchPublicData {
  version: number;
  layer2ChainId: bigint;
  rollupId: Uint8Array;
  batchIndex: bigint;
  daStartHeight: bigint;
  daEndHeight: bigint;
  daCommitment: Uint8Array;
  lastProcessedQueueIndex: bigint;
  messageQueueHash: Uint8Array;
  prevStateRoot: Uint8Array;
  prevBatchHash: Uint8Array;
  postStateRoot: Uint8Array;
  batchHash: Uint8Array;
  withdrawRoot: Uint8Array;
}

// ============================================================================
// INTEGER RANGE CONSTANTS AND VALIDATION
// ============================================================================

export const MAX_U64 = (1n << 64n) - 1n;
export const MAX_U128 = (1n << 128n) - 1n;

/**
 * Assert that a value fits in u64 range [0, 2^64-1].
 * @throws if value is out of range
 */
export function assertU64(x: bigint, name: string): void {
  if (x < 0n || x > MAX_U64) {
    throw new Error(`${name} out of u64 range: ${x}`);
  }
}

/**
 * Assert that a value fits in u128 range [0, 2^128-1].
 * @throws if value is out of range
 */
export function assertU128(x: bigint, name: string): void {
  if (x < 0n || x > MAX_U128) {
    throw new Error(`${name} out of u128 range: ${x}`);
  }
}

// ============================================================================
// INTEGER ENCODING (Little-Endian, 32 bytes)
// ============================================================================

/**
 * Encode a bigint as 32-byte little-endian.
 * This matches Compact's Field -> Bytes<n> casting.
 *
 * @throws if value is negative or doesn't fit in 32 bytes
 */
export function uToBytes32LE(x: bigint): Uint8Array {
  if (x < 0n) throw new Error("negative value not allowed");
  const out = new Uint8Array(32);
  let v = x;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error("integer does not fit in 32 bytes");
  return out;
}

// Legacy exports for compatibility
export function encodeUint128(value: bigint): Uint8Array {
  return uToBytes32LE(value);
}

export function encodeUint64(value: bigint): Uint8Array {
  return uToBytes32LE(value);
}

// ============================================================================
// BYTES HELPERS
// ============================================================================

/**
 * Pad a string to 32 bytes (right-padded with zeros).
 * THROWS if string is longer than 32 bytes (no silent truncation).
 */
export function strictPadBytes32(s: string): Uint8Array {
  const bytes = Buffer.from(s, "utf8");
  if (bytes.length > 32) {
    throw new Error(
      `String too long for bytes32: ${bytes.length} bytes, max 32. String: "${s}"`
    );
  }
  const result = new Uint8Array(32);
  result.set(bytes);
  return result;
}

/**
 * Pad a string to 32 bytes (legacy, but now throws on overflow)
 */
export function padBytes32(s: string): Uint8Array {
  return strictPadBytes32(s);
}

/**
 * Create a zero-filled 32-byte array
 */
export function zeroBytes32(): Uint8Array {
  return new Uint8Array(32);
}

/**
 * Concatenate multiple Uint8Arrays
 */
export function concat(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Concatenate bytes32 chunks with validation
 */
export function concatBytes32Chunks(chunks: Uint8Array[]): Uint8Array {
  for (const chunk of chunks) {
    if (chunk.length !== 32) {
      throw new Error(`Chunk must be 32 bytes, got ${chunk.length}`);
    }
  }
  return concat(...chunks);
}

/**
 * Compute SHA-256 hash
 */
export function sha256(data: Uint8Array): Uint8Array {
  const hash = createHash("sha256");
  hash.update(data);
  return new Uint8Array(hash.digest());
}

// ============================================================================
// HASH FUNCTIONS (sha256 over bytes32 chunks)
// ============================================================================

/**
 * Compute the canonical hash of an L1→L2 deposit message.
 *
 * Hash = sha256(DS || sender || recipient || amount_LE32 || nonce_LE32 || gasLimit_LE32 || dataHash)
 * Total: 7 chunks × 32 bytes = 224 bytes
 *
 * @throws if integer fields exceed their type limits
 */
export function hashL1ToL2Deposit(msg: L1ToL2DepositMessage): Uint8Array {
  // Validate integer ranges (Compact would reject out-of-range values)
  assertU128(msg.amount, "amount");
  assertU64(msg.nonce, "nonce");
  assertU64(msg.gasLimit, "gasLimit");

  const preimage = concatBytes32Chunks([
    DS_L1_TO_L2_DEPOSIT,
    msg.sender,
    msg.recipient,
    uToBytes32LE(msg.amount),
    uToBytes32LE(msg.nonce),
    uToBytes32LE(msg.gasLimit),
    msg.dataHash
  ]);
  return sha256(preimage);
}

/**
 * Compute the canonical hash of an L2→L1 withdrawal message.
 *
 * Hash = sha256(DS || sender || recipient || amount_LE32 || nonce_LE32)
 * Total: 5 chunks × 32 bytes = 160 bytes
 *
 * @throws if integer fields exceed their type limits
 */
export function hashL2ToL1Withdraw(msg: L2ToL1WithdrawMessage): Uint8Array {
  // Validate integer ranges (Compact would reject out-of-range values)
  assertU128(msg.amount, "amount");
  assertU64(msg.nonce, "nonce");

  const preimage = concatBytes32Chunks([
    DS_L2_TO_L1_WITHDRAW,
    msg.sender,
    msg.recipient,
    uToBytes32LE(msg.amount),
    uToBytes32LE(msg.nonce)
  ]);
  return sha256(preimage);
}

/**
 * Compute the initial rolling hash (for the first message in the queue).
 * hash[0] = sha256(DS || 0x00...00 || txHash_0)
 */
export function computeInitialRollingHash(
  firstLeafHash: Uint8Array
): Uint8Array {
  const preimage = concatBytes32Chunks([
    DS_L1_QUEUE_ROLLING,
    zeroBytes32(),
    firstLeafHash
  ]);
  return sha256(preimage);
}

/**
 * Extend the rolling hash with a new message.
 * hash[n] = sha256(DS || hash[n-1] || txHash_n)
 */
export function extendRollingHash(
  prevHash: Uint8Array,
  newLeafHash: Uint8Array
): Uint8Array {
  const preimage = concatBytes32Chunks([
    DS_L1_QUEUE_ROLLING,
    prevHash,
    newLeafHash
  ]);
  return sha256(preimage);
}

/**
 * Compute the merkle tree leaf from a withdrawal message hash.
 * This adds domain separation for second-preimage attack prevention.
 */
export function computeWithdrawLeaf(messageHash: Uint8Array): Uint8Array {
  const preimage = concatBytes32Chunks([DS_L2_WITHDRAW_LEAF, messageHash]);
  return sha256(preimage);
}

// =============================================================================
// BATCH PUBLIC DATA HASHING (Phase 7)
// =============================================================================

/**
 * Hash batch public data for oracle signing.
 * 
 * Layout: DS || batchIndex_LE32 || prevStateRoot || postStateRoot || 
 *         withdrawRoot || l1MessageQueueHash || lastL1MessageIndex_LE32
 * = 7 chunks × 32 bytes = 224 bytes
 * 
 * This is the hash that oracle committee members sign to finalize a batch.
 * The L1/L2 contracts verify threshold signatures over this hash.
 * 
 * @param batch - The batch public data to hash
 * @returns 32-byte sha256 hash
 * @throws if integer fields exceed their type limits
 */
export function hashBatchPublicData(batch: BatchPublicDataV1): Uint8Array {
  // Validate integer ranges
  assertU64(batch.batchIndex, "batchIndex");
  assertU64(batch.lastL1MessageIndex, "lastL1MessageIndex");

  const preimage = concatBytes32Chunks([
    padBytes32(DS_BATCH_PUBLIC_DATA),
    uToBytes32LE(batch.batchIndex),
    batch.prevStateRoot,
    batch.postStateRoot,
    batch.withdrawRoot,
    batch.l1MessageQueueHash,
    uToBytes32LE(batch.lastL1MessageIndex)
  ]);
  return sha256(preimage);
}

/**
 * Compute merkle tree internal node hash.
 * H(left || right) - standard merkle hash, no domain separation.
 *
 * NOTE: V1 does NOT use domain separation for merkle nodes to match
 * standard implementations. Domain separation is applied at the leaf level.
 *
 * @throws if left or right are not exactly 32 bytes
 */
export function computeMerkleNodeHash(
  left: Uint8Array,
  right: Uint8Array
): Uint8Array {
  // Validate inputs are 32 bytes
  if (left.length !== 32) {
    throw new Error(`left child must be 32 bytes, got ${left.length}`);
  }
  if (right.length !== 32) {
    throw new Error(`right child must be 32 bytes, got ${right.length}`);
  }
  return sha256(concat(left, right));
}

// ============================================================================
// ZERO HASHES (Pre-computed)
// ============================================================================

/**
 * Compute the zero hash for a given level of the merkle tree.
 * zeroHash[0] = H(0, 0)
 * zeroHash[n] = H(zeroHash[n-1], zeroHash[n-1])
 */
export function computeZeroHash(level: number): Uint8Array {
  if (level === 0) {
    return computeMerkleNodeHash(zeroBytes32(), zeroBytes32());
  }
  const prevZero = computeZeroHash(level - 1);
  return computeMerkleNodeHash(prevZero, prevZero);
}

/**
 * Pre-compute zero hashes for levels 0 through maxLevel (inclusive).
 */
export function precomputeZeroHashes(maxLevel: number): Uint8Array[] {
  const result: Uint8Array[] = [];
  for (let i = 0; i <= maxLevel; i++) {
    if (i === 0) {
      result.push(computeMerkleNodeHash(zeroBytes32(), zeroBytes32()));
    } else {
      result.push(computeMerkleNodeHash(result[i - 1], result[i - 1]));
    }
  }
  return result;
}

// ============================================================================
// MERKLE TREE HELPERS
// ============================================================================

/**
 * Compute the merkle root from an array of leaves.
 *
 * IMPORTANT: Uses 2 ** treeDepth (not 1 << treeDepth) to avoid JS bit-shift bugs.
 * Empty leaves are padded with 0x00...00 (32 zero bytes).
 *
 * @throws if any leaf is not 32 bytes
 * @throws if there are more leaves than the tree can hold
 */
export function computeMerkleRoot(
  leaves: Uint8Array[],
  treeDepth: number
): Uint8Array {
  // Use 2 ** depth, NOT 1 << depth (bit shift breaks for depth >= 31)
  const numLeaves = 2 ** treeDepth;

  if (numLeaves > Number.MAX_SAFE_INTEGER) {
    throw new Error(
      `Tree depth ${treeDepth} too large for safe integer arithmetic`
    );
  }

  // Validate: not too many leaves
  if (leaves.length > numLeaves) {
    throw new Error(
      `Too many leaves: got ${leaves.length}, max ${numLeaves} for depth=${treeDepth}`
    );
  }

  // Validate: all leaves are 32 bytes
  for (let i = 0; i < leaves.length; i++) {
    if (leaves[i].length !== 32) {
      throw new Error(`leaf[${i}] must be 32 bytes, got ${leaves[i].length}`);
    }
  }

  // Initialize current level with leaves + zero padding (using 0x00...00)
  const emptyLeaf = zeroBytes32();
  const currentLevel = new Array(numLeaves);
  for (let i = 0; i < numLeaves; i++) {
    currentLevel[i] = i < leaves.length ? leaves[i] : emptyLeaf;
  }

  // Build tree bottom-up
  let levelSize = numLeaves;
  while (levelSize > 1) {
    const nextSize = levelSize / 2;
    for (let i = 0; i < nextSize; i++) {
      currentLevel[i] = computeMerkleNodeHash(
        currentLevel[2 * i],
        currentLevel[2 * i + 1]
      );
    }
    levelSize = nextSize;
  }

  return currentLevel[0];
}

/**
 * Generate a merkle proof for a leaf at the given index.
 *
 * @throws if leafIndex is out of range
 * @throws if any leaf is not 32 bytes
 * @throws if there are more leaves than the tree can hold
 */
export function generateMerkleProof(
  leaves: Uint8Array[],
  leafIndex: number,
  treeDepth: number
): { proof: Uint8Array[]; pathBits: boolean[] } {
  const numLeaves = 2 ** treeDepth;
  const emptyLeaf = zeroBytes32();

  // Validate leafIndex
  if (leafIndex < 0 || leafIndex >= numLeaves) {
    throw new Error(
      `leafIndex out of range: ${leafIndex}, valid range: [0, ${numLeaves - 1}]`
    );
  }

  // Validate: not too many leaves
  if (leaves.length > numLeaves) {
    throw new Error(
      `Too many leaves: got ${leaves.length}, max ${numLeaves} for depth=${treeDepth}`
    );
  }

  // Validate: all leaves are 32 bytes
  for (let i = 0; i < leaves.length; i++) {
    if (leaves[i].length !== 32) {
      throw new Error(`leaf[${i}] must be 32 bytes, got ${leaves[i].length}`);
    }
  }

  // Initialize current level
  let currentLevel = new Array(numLeaves);
  for (let i = 0; i < numLeaves; i++) {
    currentLevel[i] = i < leaves.length ? leaves[i] : emptyLeaf;
  }

  const proof: Uint8Array[] = [];
  const pathBits: boolean[] = [];
  let currentIndex = leafIndex;

  // Build tree and collect proof
  for (let level = 0; level < treeDepth; level++) {
    const siblingIndex = currentIndex ^ 1;
    proof.push(currentLevel[siblingIndex]);
    pathBits.push((currentIndex & 1) === 0); // true if we are left child

    // Build next level
    const nextSize = currentLevel.length / 2;
    const nextLevel = new Array(nextSize);
    for (let i = 0; i < nextSize; i++) {
      nextLevel[i] = computeMerkleNodeHash(
        currentLevel[2 * i],
        currentLevel[2 * i + 1]
      );
    }
    currentLevel = nextLevel;
    currentIndex = Math.floor(currentIndex / 2);
  }

  return { proof, pathBits };
}

/**
 * Verify a merkle proof.
 *
 * @throws if proof and pathBits have different lengths
 * @throws if leaf, proof elements, or root are not 32 bytes
 */
export function verifyMerkleProof(
  leaf: Uint8Array,
  proof: Uint8Array[],
  pathBits: boolean[],
  root: Uint8Array
): boolean {
  // Validate proof and pathBits lengths match
  if (proof.length !== pathBits.length) {
    throw new Error(
      `proof length (${proof.length}) must match pathBits length (${pathBits.length})`
    );
  }

  // Validate leaf is 32 bytes
  if (leaf.length !== 32) {
    throw new Error(`leaf must be 32 bytes, got ${leaf.length}`);
  }

  // Validate root is 32 bytes
  if (root.length !== 32) {
    throw new Error(`root must be 32 bytes, got ${root.length}`);
  }

  // Validate all proof elements are 32 bytes
  for (let i = 0; i < proof.length; i++) {
    if (proof[i].length !== 32) {
      throw new Error(`proof[${i}] must be 32 bytes, got ${proof[i].length}`);
    }
  }

  let current = leaf;
  for (let i = 0; i < proof.length; i++) {
    if (pathBits[i]) {
      // We are the left child
      current = computeMerkleNodeHash(current, proof[i]);
    } else {
      // We are the right child
      current = computeMerkleNodeHash(proof[i], current);
    }
  }
  return bytesEqual(current, root);
}

// ============================================================================
// INCREMENTAL MERKLE TREE (matches L2MessageQueue.compact)
// ============================================================================

/**
 * Incremental Merkle Tree for append-only operations.
 *
 * This class matches the L2MessageQueue.compact implementation exactly.
 * It efficiently maintains a Merkle root as leaves are appended one by one.
 *
 * ALGORITHM:
 * When inserting leaf at index N:
 * 1. Convert N to binary to determine the path
 * 2. Walk up from leaf level (level 0) to root (level treeDepth)
 * 3. At each level i:
 *    - If bit i of N is 0: store current hash in branch[i] (new subtree)
 *    - If bit i of N is 1: hash(branch[i], current) and continue (complete subtree)
 * 4. The final hash is the new root
 */
export class IncrementalMerkleTree {
  private readonly depth: number;
  private readonly branches: Uint8Array[];
  private readonly zeroHashes: Uint8Array[];
  private nextIndex: number;
  private currentRoot: Uint8Array;

  constructor(depth: number) {
    if (depth < 1 || depth > 40) {
      throw new Error(`Tree depth must be between 1 and 40, got ${depth}`);
    }
    this.depth = depth;
    this.branches = new Array(depth).fill(null).map(() => zeroBytes32());
    this.zeroHashes = precomputeZeroHashes(depth);
    this.nextIndex = 0;
    // Initial root is computed by simulating an empty tree
    // This should match computeMerkleRoot([], depth)
    this.currentRoot = this.computeEmptyRoot();
  }

  /**
   * Compute the root of an empty tree.
   * This matches computeMerkleRoot([], depth).
   */
  private computeEmptyRoot(): Uint8Array {
    // An empty tree at each level:
    // - Level 0: all leaves are 0x00...00
    // - Level 1: all nodes are H(0, 0) = zeroHashes[0]
    // - Level N: all nodes are zeroHashes[N-1]
    // The root is zeroHashes[depth-1]
    return this.zeroHashes[this.depth - 1];
  }

  /**
   * Get the current Merkle root.
   */
  getRoot(): Uint8Array {
    return this.currentRoot;
  }

  /**
   * Get the number of leaves in the tree.
   */
  getLeafCount(): number {
    return this.nextIndex;
  }

  /**
   * Append a leaf to the tree and update the root.
   * Returns the index of the appended leaf.
   *
   * At each level:
   * - Level 0: empty sibling is 0x00...00 (empty leaf)
   * - Level N (N>0): empty sibling is zeroHashes[N-1] (hash of empty subtree of height N)
   */
  append(leafHash: Uint8Array): number {
    if (leafHash.length !== 32) {
      throw new Error(`Leaf hash must be 32 bytes, got ${leafHash.length}`);
    }

    const maxLeaves = 2 ** this.depth;
    if (this.nextIndex >= maxLeaves) {
      throw new Error(
        `Tree is full: ${this.nextIndex} leaves, max ${maxLeaves}`
      );
    }

    const index = this.nextIndex;
    let current = leafHash;

    // Walk up the tree
    for (let level = 0; level < this.depth; level++) {
      const bit = (index >> level) & 1;

      if (bit === 0) {
        // We're the left child - store current in branch, combine with empty sibling
        this.branches[level] = current;
        // At level 0, empty sibling is an empty leaf (0x00...00)
        // At level N>0, empty sibling is zeroHashes[N-1] (complete empty subtree)
        const emptySibling =
          level === 0 ? zeroBytes32() : this.zeroHashes[level - 1];
        current = computeMerkleNodeHash(current, emptySibling);
      } else {
        // We're the right child - combine with stored branch
        current = computeMerkleNodeHash(this.branches[level], current);
      }
    }

    this.currentRoot = current;
    this.nextIndex++;

    return index;
  }

  /**
   * Get all appended leaves' hashes by reconstructing from branches.
   * NOTE: This is for debugging/testing only. In production, leaves should
   * be stored separately (e.g., in a database or event log).
   */
  getBranches(): Uint8Array[] {
    return [...this.branches];
  }

  /**
   * Create a new tree from a list of leaves.
   * Useful for testing and verification.
   */
  static fromLeaves(
    leaves: Uint8Array[],
    depth: number
  ): IncrementalMerkleTree {
    const tree = new IncrementalMerkleTree(depth);
    for (const leaf of leaves) {
      tree.append(leaf);
    }
    return tree;
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Convert Uint8Array to hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Convert hex string to Uint8Array.
 *
 * @throws if hex string has odd length
 * @throws if hex string contains invalid characters
 */
export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (cleanHex.length % 2 !== 0) {
    throw new Error("hex string length must be even");
  }
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byteStr = cleanHex.slice(i * 2, i * 2 + 2);
    const v = Number.parseInt(byteStr, 16);
    if (!Number.isFinite(v)) {
      throw new Error(`invalid hex byte: "${byteStr}"`);
    }
    bytes[i] = v;
  }
  return bytes;
}

/**
 * Compare two Uint8Arrays for equality
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ============================================================================
// TEST VECTOR INPUTS (for golden vectors, see test/golden-vectors-v1.json)
// ============================================================================

export const TEST_VECTOR_INPUTS = {
  // Withdrawal message test vector: alice -> bob, 1e18, nonce 1
  withdrawal1: {
    sender: padBytes32("alice"),
    recipient: padBytes32("bob"),
    amount: 1000000000000000000n, // 1e18
    nonce: 1n
  } as L2ToL1WithdrawMessage,

  // Deposit message test vector: zero -> alice, 1e18, nonce 42, gas 100000
  deposit1: {
    sender: zeroBytes32(),
    recipient: padBytes32("alice"),
    amount: 1000000000000000000n,
    nonce: 42n,
    gasLimit: 100000n,
    dataHash: zeroBytes32()
  } as L1ToL2DepositMessage
};

// =============================================================================
// INDEX BITS HELPERS (for Merkle tree witness)
// =============================================================================

/**
 * Compute the 16-bit binary decomposition of an index.
 * Returns an array of 16 booleans where bit[i] = true if bit i is set.
 * 
 * Example: index = 5 (binary: 101) -> [true, false, true, false, false, ...]
 */
export function computeIndexBits(index: bigint, numBits: number = 16): boolean[] {
  assertU64(index, "index");
  if (numBits < 1 || numBits > 64) {
    throw new Error(`numBits must be 1-64, got ${numBits}`);
  }
  
  const bits: boolean[] = [];
  for (let i = 0; i < numBits; i++) {
    bits.push((index & (1n << BigInt(i))) !== 0n);
  }
  return bits;
}

/**
 * Verify that a bit decomposition correctly represents the index.
 * This mirrors the Compact verifyBitDecomposition circuit.
 */
export function verifyBitDecomposition(bits: boolean[], index: bigint): boolean {
  let sum = 0n;
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) {
      sum += 1n << BigInt(i);
    }
  }
  return sum === index;
}
