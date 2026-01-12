# L1 Smart Contract Architecture

## Table of Contents

1. [Contract Architecture & Separation of Concerns](#1-contract-architecture--separation-of-concerns)
2. [L1 Contract Storage](#2-l1-contract-storage)
3. [L1 Message Queue Storage](#3-l1-message-queue-storage)
4. [Batch Lifecycle](#4-batch-lifecycle)
5. [L1 → L2 Deposits](#5-l1--l2-deposits)
6. [L2 → L1 Withdrawals](#6-l2--l1-withdrawals)
7. [Appendix A: Data Structures](#appendix-a-data-structures)
8. [Appendix B: Gas Costs](#appendix-b-gas-costs)
9. [Appendix C: Contract Interfaces](#appendix-c-contract-interfaces)

---

## 1. Contract Architecture & Separation of Concerns

This architecture follows a **single responsibility per contract** design philosophy. Each component handles one concern, making the system easier to audit, upgrade, and secure.

### 1.1 Why Separate Components?

```
+-----------------------------------------------------------------+
|                   THE PROBLEM WITH MONOLITHS                    |
+-----------------------------------------------------------------+
|                                                                 |
|  X One contract does everything:                               |
|                                                                 |
|  contract MonolithBridge {                                      |
|      function depositNIGHT() { ... }                            |
|      function depositToken() { ... }                            |
|      function depositNFT() { ... }                              |
|      function withdraw() { ... }                                |
|      function verifyProof() { ... }                             |
|      function queueMessage() { ... }                            |
|      function finalizeBatch() { ... }                           |
|      // 50+ more functions...                                   |
|  }                                                              |
|                                                                 |
|  Problems:                                                      |
|  * Huge attack surface - one bug affects everything             |
|  * Can't upgrade parts independently                            |
|  * Hits contract size limits                                    |
|  * Hard to audit - reviewers can't focus                        |
|  * Single point of failure                                      |
|                                                                 |
+-----------------------------------------------------------------+
```

### 1.2 The Layered Architecture

```
+-----------------------------------------------------------------+
|                    CONTRACT RESPONSIBILITY LAYERS               |
+-----------------------------------------------------------------+
|                                                                 |
|  LAYER 1: GATEWAYS (Asset-Specific Logic)                       |
|  -----------------------------------------                      |
|  +--------------+ +--------------+ +--------------+             |
|  | NIGHTGateway | | TokenGateway | | NFTGateway   |             |
|  |              | |              | |              |             |
|  | * Lock NIGHT | | * Lock tokens| | * Lock NFTs  |             |
|  | * Encode msg | | * Approvals  | | * Token IDs  |             |
|  +------+-------+ +------+-------+ +------+-------+             |
|         |                |                |                     |
|         +----------------+----------------+                     |
|                          v                                      |
|  LAYER 2: MESSENGER (Cross-Domain Messaging)                    |
|  -----------------------------------------                      |
|  +---------------------------------------------------------+    |
|  |                    L1Messenger                           |   |
|  |                                                          |   |
|  | * Message nonce assignment (prevent replay)              |   |
|  | * Fee collection (pay for L2 gas)                        |   |
|  | * NIGHT custody (all deposited NIGHT locked here)        |   |
|  | * Message tracking (for replays/refunds)                 |   |
|  | * Withdrawal proof verification                          |   |
|  +-------------------------+-------------------------------+    |
|                            v                                    |
|  LAYER 3: MESSAGE QUEUE (Ordered Storage)                       |
|  -----------------------------------------                      |
|  +---------------------------------------------------------+    |
|  |                    L1MessageQueue                        |   |
|  |                                                          |   |
|  | * Rolling hash commitment (chain all messages)           |   |
|  | * Timestamp tracking (for enforced mode)                 |   |
|  | * Message indices (unique IDs)                           |   |
|  | * Finalization tracking                                  |   |
|  +-------------------------+-------------------------------+    |
|                            v                                    |
|  LAYER 4: ROLLUP CHAIN (State Verification)                     |
|  -----------------------------------------                      |
|  +---------------------------------------------------------+    |
|  |                    RollupChain                           |   |
|  |                                                          |   |
|  | * State root storage                                     |   |
|  | * Withdraw root storage                                  |   |
|  | * Batch hash storage                                     |   |
|  | * Proof verification                                     |   |
|  | * Chain continuity checks                                |   |
|  +---------------------------------------------------------+    |
|                                                                 |
+-----------------------------------------------------------------+
```

### 1.3 Component Responsibilities

| Component | Single Responsibility | What It Does NOT Do |
| :---- | :---- | :---- |
| **Gateway** | Asset handling | ❌ Message ordering, ❌ Proof verification |
| **Messenger** | Cross-chain messaging | ❌ Asset logic, ❌ State storage |
| **MessageQueue** | Message commitment | ❌ Proof verification, ❌ Asset handling |
| **RollupChain** | State verification | ❌ Message handling, ❌ Asset logic |

### 1.4 Trust Boundaries

```
+-----------------------------------------------------------------+
|                       TRUST BOUNDARIES                          |
+-----------------------------------------------------------------+
|                                                                 |
|  Gateway (NIGHT, Tokens, etc.)                                  |
|  ----------------------------                                   |
|  Trust: Only handles specific asset type                        |
|  Risk: Bug = lose tokens in THAT gateway only                   |
|  Upgrade: Can add new gateways without touching core            |
|                                                                 |
|  Messenger                                                      |
|  ----------------------------                                   |
|  Trust: Handles ALL cross-chain messages                        |
|  Risk: Bug = entire bridge compromised                          |
|  Security: Most audited, most critical                          |
|                                                                 |
|  MessageQueue                                                   |
|  ----------------------------                                   |
|  Trust: Determines what L2 MUST execute                         |
|  Risk: Bug = censorship or replay attacks                       |
|  Security: Simple logic, verifiable                             |
|                                                                 |
|  RollupChain                                                    |
|  ----------------------------                                   |
|  Trust: Validates L2 state transitions                          |
|  Risk: Bug = invalid state accepted                             |
|  Security: MOST CRITICAL - protects all user funds              |
|                                                                 |
+-----------------------------------------------------------------+
```

### 1.5 Data Flow Between Components

```
L1 > L2 DEPOSIT FLOW:
---------------------

User
 |
 | depositNIGHT(amount)
 v
+--------------------+
|    NIGHTGateway    |  < LAYER 1: Asset Logic
|                    |
| * Lock NIGHT       |
| * Encode message   |
+---------+----------+
          | sendMessage(to, value, data)
          v
+--------------------+
|    Messenger       |  < LAYER 2: Messaging
|                    |
| * Assign nonce     |
| * Collect fee      |
| * Track message    |
+---------+----------+
          | appendCrossDomainMessage()
          v
+--------------------+
|   MessageQueue     |  < LAYER 3: Storage
|                    |
| * Compute hash     |
| * Update rolling   |
|   hash chain       |
| * Store timestamp  |
+---------+----------+
          |
          | (L2 reads and executes)
          v
      L2 execution


L2 > L1 WITHDRAWAL FLOW:
------------------------

L2 User initiates withdrawal
          |
          | (included in batch, attested)
          v
+--------------------+
|   RollupChain      |  < LAYER 4: Verification
|                    |
| * Verify proof     |
| * Store stateRoot  |
| * Store withdrawRoot|
+---------+----------+
          |
          | (user claims with merkle proof)
          v
+--------------------+
|    Messenger       |  < LAYER 2: Proof Check
|                    |
| * Check finalized  |
| * Verify merkle    |
|   proof            |
| * Execute message  |
+---------+----------+
          |
          v
+--------------------+
|    NIGHTGateway    |  < LAYER 1: Asset Release
|                    |
| * Transfer NIGHT   |
|   to user          |
+--------------------+
```

### 1.6 Benefits of This Architecture

| Benefit | How It's Achieved |
| :---- | :---- |
| **Auditability** | Each contract is small and focused |
| **Upgradeability** | Can upgrade one layer without touching others |
| **Security isolation** | Bug in Gateway doesn't affect Messenger |
| **Extensibility** | Add new gateways (NFT, etc.) without core changes |
| **Gas efficiency** | Each contract optimized for its specific task |
| **Testing** | Can unit test each component in isolation |

### 1.7 Contract Interaction Matrix

```
                    | Gateway | Messenger | MessageQueue | RollupChain |
--------------------+---------+-----------+--------------+-------------+
Gateway calls       |    -    |    Y      |      X       |      X      |
Messenger calls     |    X    |    -      |      Y       |      Y      |
MessageQueue calls  |    X    |    X      |      -       |      X      |
RollupChain calls   |    X    |    X      |      Y       |      -      |
User calls          |    Y    |    Y      |      X       |      X      |
Sequencer calls     |    X    |    X      |      X       |      Y      |
Prover calls        |    X    |    X      |      X       |      Y      |

Y = calls directly
X = does not call (separation enforced)
```

### 1.8 Immutable vs Upgradeable Components

```
+-----------------------------------------------------------------+
|                    UPGRADE STRATEGY                             |
+-----------------------------------------------------------------+
|                                                                 |
|  IMMUTABLE REFERENCES (set at deployment, never change):        |
|  -----------------------------------------------------          |
|  * Gateway > Messenger address                                  |
|  * Messenger > MessageQueue address                             |
|  * Messenger > RollupChain address                              |
|  * RollupChain > MessageQueue address                           |
|                                                                 |
|  Why? Prevents upgrade attacks, ensures consistent behavior     |
|                                                                 |
|  UPGRADEABLE VIA PROXY:                                         |
|  -----------------------------------------------------          |
|  * Gateway logic (add new asset features)                       |
|  * Messenger logic (fix bugs, add features)                     |
|  * RollupChain logic (change verification method)               |
|                                                                 |
|  Why? Allow improvements without redeploying everything         |
|                                                                 |
|  ADDING NEW COMPONENTS:                                         |
|  -----------------------------------------------------          |
|  * New Gateways can be deployed anytime                         |
|  * They just need to call the existing Messenger                |
|  * No changes to core infrastructure needed                     |
|                                                                 |
+-----------------------------------------------------------------+
```

---

## 2. L1 Contract Storage

The main rollup contract on L1 stores the following data:

### 2.1 Core State Mappings

```solidity
/// @notice Batch index > batch hash
/// @dev Sparse: only stores last batch hash per commit transaction
mapping(uint256 => bytes32) public committedBatches;

/// @notice Batch index > L2 state root
/// @dev Sparse: only stores last state root per finalized bundle
mapping(uint256 => bytes32) public finalizedStateRoots;

/// @notice Batch index > withdrawal merkle root
/// @dev Sparse: only stores last withdraw root per finalized bundle
mapping(uint256 => bytes32) public withdrawRoots;
```

### 2.2 Progress Tracking

```solidity
struct RollupMiscData {
    uint64 lastCommittedBatchIndex;    // Latest batch committed to L1
    uint64 lastFinalizedBatchIndex;    // Latest batch with verified attestation
    uint32 lastFinalizeTimestamp;      // When last finalization occurred
    uint8 flags;                       // Bit flags for system state
    uint88 reserved;                   // Future use
}

RollupMiscData public miscData;
```

### 2.3 Access Control

```solidity
/// @notice Authorized sequencers who can commit batches
mapping(address => bool) public isSequencer;

/// @notice Authorized finalizers (can submit proofs)
mapping(address => bool) public isFinalizer;
```

### 2.4 Immutable Configuration

```solidity
uint64 public immutable layer2ChainId;
address public immutable messageQueue;      // L1MessageQueue address
address public immutable systemConfig;      // System configuration
```

---

## 3. L1 Message Queue Storage

The message queue handles L1 → L2 message ordering and commitment.

### 3.1 Message Storage

```solidity
/// @notice Rolling hash of all L1 > L2 messages
/// @dev Encoding: [32 bits timestamp | 224 bits rolling hash]
mapping(uint256 => bytes32) private messageRollingHashes;

/// @notice First message index in this contract (V1 messages before this)
uint256 public firstCrossDomainMessageIndex;

/// @notice Next message index to be assigned
uint256 public nextCrossDomainMessageIndex;

/// @notice First message not yet finalized on L2
uint256 public nextUnfinalizedQueueIndex;
```

### 3.2 Rolling Hash Computation

For each new L1 → L2 message:

```
hash[0] = H(msg0)
hash[n] = H(hash[n-1], H(msg_n))
```

This creates a commitment to ALL messages in order, verified by the prover.

---

## 4. Batch Lifecycle

### 4.1 Commit Phase

```
Sequencer                              L1 Contract
--------                               -----------

1. Build N L2 blocks
2. Post block data to DA
3. Compute batch hash
        |
        |  commitBatch(batchHash, parentBatchHash)
        v
                                       4. Verify parentBatchHash matches
                                          committedBatches[lastIndex]
                                       5. Store committedBatches[newIndex]
                                       6. Update lastCommittedBatchIndex
                                       7. Emit CommitBatch event
```

### 4.2 Attestation Phase

```
Full Node                 Prover                   Verifier
---------                 ------                   --------

1. Download blocks
   from DA
        |
        |  execute(blocks, prevState)
        v
                          2. Re-execute all txs
                          3. Compute state roots
                          4. Build withdraw tree
                          5. Generate attestation
        |
        |  attestation + batchPublicData
        v
                                                   6. Verify attestation
                                                   7. Validate outputs
                                                   8. Collect signatures
```

### 4.3 Finalization Phase

```
Verifier                                          L1 Contract
--------                                          -----------

1. Receive attestation from prover
2. Verify attestation validity
3. Collect threshold signatures
        |
        |  finalizeBatch(batchHeader, stateRoot,
        |                withdrawRoot, signatures)
        v
                                                   4. Verify signatures
                                                   5. Check signature threshold
                                                   6. Verify chain continuity
                                                   7. Store finalizedStateRoots
                                                   8. Store withdrawRoots
                                                   9. Update message queue
                                                   10. Emit FinalizeBatch
```

---

## 5. L1 → L2 Deposits

### 5.1 Overview

```
+-----------------------------------------------------------------------------+
|                                   L1                                        |
+-----------------------------------------------------------------------------+
|                                                                             |
|  1. USER calls depositNIGHT(amount, gasLimit)                               |
|     |                                                                       |
|     v                                                                       |
|  2. L1NIGHTGateway                                                          |
|     +-- Locks NIGHT in gateway/messenger                                    |
|     +-- Encodes message: finalizeDepositNIGHT(from, to, amount)             |
|     +-- Calls L1Messenger.sendMessage()                                     |
|     |                                                                       |
|     v                                                                       |
|  3. L1Messenger                                                             |
|     +-- Assigns nonce from nextCrossDomainMessageIndex                      |
|     +-- Computes message hash                                               |
|     +-- Collects fee for L2 gas                                             |
|     +-- Calls L1MessageQueue.appendCrossDomainMessage()                     |
|     |                                                                       |
|     v                                                                       |
|  4. L1MessageQueue                                                          |
|     +-- Computes transaction hash                                           |
|     +-- Updates rolling hash: hash[n] = H(hash[n-1], txHash)                |
|     +-- Stores timestamp with rolling hash                                  |
|     +-- Increments nextCrossDomainMessageIndex                              |
|     +-- Emits QueueTransaction event                                        |
|                                                                             |
+-----------------------------------------------------------------------------+
                                    |
                                    | Sequencer monitors QueueTransaction events
                                    | Includes L1 messages in L2 blocks
                                    |
+-----------------------------------------------------------------------------+
|                                   L2                                        |
+-----------------------------------------------------------------------------+
|                                                                             |
|  5. Sequencer includes L1 message as special transaction (type 0x7E)        |
|     |                                                                       |
|     v                                                                       |
|  6. L2Messenger.relayMessage() executes automatically                       |
|     +-- Verifies sender is aliased L1Messenger                              |
|     +-- Sets xDomainMessageSender = L1NIGHTGateway                          |
|     +-- Forwards call to L2NIGHTGateway                                     |
|     |                                                                       |
|     v                                                                       |
|  7. L2NIGHTGateway.finalizeDepositNIGHT()                                   |
|     +-- Mints/transfers NIGHT to recipient                                  |
|     +-- Emits FinalizeDepositNIGHT event                                    |
|                                                                             |
|  ✓ USER NOW HAS NIGHT ON L2                                                 |
|                                                                             |
+-----------------------------------------------------------------------------+
```

### 5.2 Message Hash Computation

```solidity
// L1 message is encoded as special transaction type 0x7E
// TransactionPayload = rlp([queueIndex, gasLimit, to, value, data, sender])
bytes32 txHash = poseidon2(0x7E || rlp([
    queueIndex,
    gasLimit,
    target,
    value,
    data,
    sender
]));
```

### 5.3 Rolling Hash Chain

```
Message 0: rollingHash[0] = H(txHash_0)
Message 1: rollingHash[1] = H(rollingHash[0], txHash_1)
Message 2: rollingHash[2] = H(rollingHash[1], txHash_2)
...
Message N: rollingHash[N] = H(rollingHash[N-1], txHash_N)
                                    |
                                    +-- This hash is included in attestation
                                        to prove ALL messages were processed
```

### 5.4 L1 Contract Message Queue Verification

The L1 contract performs **index-based verification**:

```solidity
/// @notice Verify message queue progress and advance the finalization pointer
/// @param lastProcessedQueueIndex The last message index processed (inclusive)
/// @param messageQueueHash The rolling hash at lastProcessedQueueIndex
function verifyAndAdvanceMessageQueue(
    uint256 lastProcessedQueueIndex,
    bytes32 messageQueueHash
) internal {
    // 1. Verify the rolling hash matches L1MessageQueue at this index
    require(
        messageQueueHash == 
            IL1MessageQueue(messageQueue).getMessageRollingHash(lastProcessedQueueIndex),
        "BAD_MESSAGE_QUEUE_HASH"
    );
    
    // 2. Verify monotonic progress (no skipping or going backwards)
    uint256 currentUnfinalized = IL1MessageQueue(messageQueue).nextUnfinalizedQueueIndex();
    require(
        lastProcessedQueueIndex >= currentUnfinalized - 1,
        "REGRESSED_MESSAGE_QUEUE"
    );
    
    // 3. Advance the unfinalized pointer
    // nextUnfinalizedQueueIndex = lastProcessedQueueIndex + 1
    IL1MessageQueue(messageQueue).finalizePoppedCrossDomainMessage(
        lastProcessedQueueIndex + 1
    );
}
```

**Why is the index required?** The `messageQueueHash` alone is not sufficient because:

- The L1 contract cannot derive which index produced a given rolling hash  
- Without the index, the contract cannot verify monotonic progress  
- The prover must explicitly commit to how many messages it processed

---

## 6. L2 → L1 Withdrawals

### 6.1 Overview

```
+-----------------------------------------------------------------------------+
|                                   L2                                        |
+-----------------------------------------------------------------------------+
|                                                                             |
|  1. USER calls withdrawNIGHT(amount, gasLimit)                              |
|     |                                                                       |
|     v                                                                       |
|  2. L2NIGHTGateway                                                          |
|     +-- Burns/locks NIGHT on L2                                             |
|     +-- Encodes message: finalizeWithdrawNIGHT(from, to, amount)            |
|     +-- Calls L2Messenger.sendMessage()                                     |
|     |                                                                       |
|     v                                                                       |
|  3. L2Messenger                                                             |
|     +-- Assigns nonce from L2MessageQueue.nextMessageIndex                  |
|     +-- Computes message hash (xDomainCalldataHash)                         |
|     +-- Calls L2MessageQueue.appendMessage(hash)                            |
|     |                                                                       |
|     v                                                                       |
|  4. L2MessageQueue (Append-Only Merkle Tree)                                |
|     +-- Adds message hash as new leaf                                       |
|     +-- Recomputes merkle tree                                              |
|     +-- Updates messageRoot (= withdrawRoot)                                |
|     +-- Emits AppendMessage event                                           |
|                                                                             |
+-----------------------------------------------------------------------------+
                                    |
                                    | Prover includes withdrawRoot in attestation
                                    | Batch finalized on L1 with withdrawRoot
                                    |
                                    | ~ WAIT FOR FINALIZATION
                                    |
+-----------------------------------------------------------------------------+
|                                   L1                                        |
+-----------------------------------------------------------------------------+
|                                                                             |
|  5. USER (or relayer) calls relayMessageWithProof()                         |
|     |                                                                       |
|     |  Parameters:                                                          |
|     |  - from, to, value, nonce, message (withdrawal details)               |
|     |  - batchIndex (which batch contains the withdrawal)                   |
|     |  - merkleProof (proof against withdrawRoot)                           |
|     |                                                                       |
|     v                                                                       |
|  6. L1Messenger                                                             |
|     +-- Computes xDomainCalldataHash from parameters                        |
|     +-- Checks: !isL2MessageExecuted[hash] (not already claimed)            |
|     +-- Checks: isBatchFinalized(batchIndex)                                |
|     +-- Gets: withdrawRoot = withdrawRoots[batchIndex]                      |
|     +-- Verifies: merkleProof against withdrawRoot                          |
|     +-- Executes: calls L1NIGHTGateway with message                         |
|     |                                                                       |
|     v                                                                       |
|  7. L1NIGHTGateway.finalizeWithdrawNIGHT()                                  |
|     +-- Transfers NIGHT to recipient                                        |
|     +-- Emits FinalizeWithdrawNIGHT event                                   |
|                                                                             |
|  ✓ USER NOW HAS NIGHT ON L1                                                 |
|                                                                             |
+-----------------------------------------------------------------------------+
```

### 6.2 Withdraw Merkle Tree

The L2MessageQueue maintains an append-only merkle tree:

```
                    withdrawRoot (messageRoot)
                           |
              +------------+------------+
              |                         |
           hash01                    hash23
          /    \                    /    \
        h0      h1                h2      h3
        |       |                 |       |
       msg0    msg1              msg2    msg3
        |       |                 |       |
   withdraw  withdraw         withdraw  withdraw
      #0       #1                #2       #3
```

### 6.3 Merkle Proof Structure

```solidity
struct L2MessageProof {
    uint256 batchIndex;     // Which finalized batch
    bytes merkleProof;      // Sibling hashes from leaf to root
}

// Verification:
// 1. Compute leaf = poseidon2(xDomainCalldata)
// 2. Walk up tree using merkleProof siblings
// 3. Compare computed root with withdrawRoots[batchIndex]
```

### 6.4 Efficient Tree Updates

```solidity
// Storage for O(log n) updates:
uint256 public nextMessageIndex;      // Current leaf count
bytes32[40] public branches;          // Cached intermediate hashes
bytes32[40] private zeroHashes;       // Pre-computed empty subtree hashes

// Adding a message only requires ~40 hash operations, not rebuilding entire tree
```

---

## Appendix A: Data Structures

### A.1 BatchPublicDataV1 (Consensus-Critical)

```solidity
/// @notice The canonical public data structure committed by prover and signed by verifiers
/// @dev Version 1 of the protocol. All fields are consensus-critical.
struct BatchPublicDataV1 {
    uint32  version;                    // = 1
    uint64  layer2ChainId;              // Cross-chain replay protection
    bytes32 rollupId;                   // Domain separation across rollup instances
    uint64  batchIndex;                 // The batch being finalized
    
    // DA commitment
    uint64  daStartHeight;              // DA block range start (inclusive)
    uint64  daEndHeight;                // DA block range end (inclusive)
    bytes32 daCommitment;               // Merkle root of DA block hashes
    
    // Message queue progress
    uint256 lastProcessedQueueIndex;    // Last L1>L2 message index processed
    bytes32 messageQueueHash;           // Rolling hash at that index
    
    // State transition
    bytes32 prevStateRoot;              // Starting state
    bytes32 prevBatchHash;              // Parent batch hash
    bytes32 postStateRoot;              // Resulting state
    bytes32 batchHash;                  // This batch's hash
    
    // Withdrawals
    bytes32 withdrawRoot;               // Merkle root of L2>L1 messages
}

// Canonical encoding: abi.encode(BatchPublicDataV1)
// Canonical hash: poseidon2(abi.encode(BatchPublicDataV1))
```

### A.2 Signature Bundle

```solidity
/// @notice Aggregated signatures submitted to L1
struct SignatureBundle {
    bytes[] signatures;                 // ECDSA signatures (65 bytes each)
    uint256 signerBitmap;              // Bitmap: bit i = memberList[i] signed
}
```

### A.3 Replay Prevention Rules

```
/// @notice Rules to prevent attestation replay attacks
/// 
/// 1. BATCH INDEX MONOTONICITY
///    - L1 enforces: batchIndex == lastFinalizedBatchIndex + 1
///    - Prevents replaying old batches
///
/// 2. STATE CONTINUITY
///    - prevStateRoot must match finalizedStateRoots[batchIndex - 1]
///    - prevBatchHash must match committedBatches[batchIndex - 1]
///    - Prevents forking the state
///
/// 3. MESSAGE QUEUE PROGRESS
///    - lastProcessedQueueIndex must be >= current unfinalized index
///    - Prevents skipping or replaying L1 messages
```

---

## Appendix B: Gas Costs

| Operation | Estimated Gas |
| :---- | :---- |
| Commit batch | ~50,000 |
| Finalize batch | ~100,000 |
| L1 → L2 deposit | ~80,000 |
| L2 → L1 withdrawal claim | ~100,000 |
| Signature verification | ~3,000 per sig |

---

## Appendix C: Contract Interfaces

### C.1 IRollupChain

```solidity
interface IRollupChain {
    // Events
    event CommitBatch(uint256 indexed batchIndex, bytes32 indexed batchHash);
    event FinalizeBatch(
        uint256 indexed batchIndex,
        bytes32 indexed batchHash,
        bytes32 stateRoot,
        bytes32 withdrawRoot
    );

    // Views
    function lastFinalizedBatchIndex() external view returns (uint256);
    function committedBatches(uint256 batchIndex) external view returns (bytes32);
    function finalizedStateRoots(uint256 batchIndex) external view returns (bytes32);
    function withdrawRoots(uint256 batchIndex) external view returns (bytes32);
    function isBatchFinalized(uint256 batchIndex) external view returns (bool);
    function rollupId() external view returns (bytes32);

    // Mutations
    function commitBatch(bytes32 parentBatchHash, bytes32 batchHash) external;
    
    /// @notice Finalize a batch with signatures over BatchPublicDataV1
    /// @param batchPublicDataAbi ABI-encoded BatchPublicDataV1 struct
    /// @param signatures Signatures over the digest
    /// @param signerBitmap Bitmap indicating which members signed
    function finalizeBatch(
        bytes calldata batchPublicDataAbi,
        bytes[] calldata signatures,
        uint256 signerBitmap
    ) external;
}
```

### C.1.1 finalizeBatch Verification Logic

```solidity
function finalizeBatch(
    bytes calldata batchPublicDataAbi,
    bytes[] calldata signatures,
    uint256 signerBitmap
) external {
    // 1. Decode the full BatchPublicDataV1
    BatchPublicDataV1 memory bpd = abi.decode(batchPublicDataAbi, (BatchPublicDataV1));
    
    // 2. Verify version
    require(bpd.version == 1, "INVALID_VERSION");
    
    // 3. Verify chain/rollup identity
    require(bpd.layer2ChainId == layer2ChainId, "WRONG_CHAIN");
    require(bpd.rollupId == rollupId, "WRONG_ROLLUP");
    
    // 4. Verify batch index is next expected
    require(bpd.batchIndex == lastFinalizedBatchIndex + 1, "WRONG_BATCH_INDEX");
    
    // 5. Verify state continuity
    require(
        bpd.prevStateRoot == finalizedStateRoots[lastFinalizedBatchIndex],
        "BAD_PREV_STATE_ROOT"
    );
    require(
        bpd.prevBatchHash == committedBatches[lastFinalizedBatchIndex],
        "BAD_PREV_BATCH_HASH"
    );
    
    // 6. Verify batch was committed
    require(
        bpd.batchHash == committedBatches[bpd.batchIndex],
        "BATCH_NOT_COMMITTED"
    );
    
    // 7. Verify message queue progress
    require(
        bpd.messageQueueHash == 
            IL1MessageQueue(messageQueue).getMessageRollingHash(bpd.lastProcessedQueueIndex),
        "BAD_MESSAGE_QUEUE_HASH"
    );
    
    // 8. Compute hashes and verify signatures
    bytes32 bpdHash = poseidon2(batchPublicDataAbi);
    bytes32 digest = computeDigest(bpdHash, bpd);
    
    require(
        verifyThresholdSignatures(digest, signatures, signerBitmap),
        "INSUFFICIENT_SIGNATURES"
    );
    
    // 9. Store results
    finalizedStateRoots[bpd.batchIndex] = bpd.postStateRoot;
    withdrawRoots[bpd.batchIndex] = bpd.withdrawRoot;
    lastFinalizedBatchIndex = bpd.batchIndex;
    
    // 10. Advance message queue
    IL1MessageQueue(messageQueue).finalizePoppedCrossDomainMessage(
        bpd.lastProcessedQueueIndex + 1
    );
    
    emit FinalizeBatch(bpd.batchIndex, bpd.batchHash, bpd.postStateRoot, bpd.withdrawRoot);
}
```

### C.2 IL1MessageQueue

```solidity
interface IL1MessageQueue {
    function nextCrossDomainMessageIndex() external view returns (uint256);
    function getMessageRollingHash(uint256 index) external view returns (bytes32);
    function appendCrossDomainMessage(
        address target,
        uint256 gasLimit,
        bytes calldata data
    ) external;
    function finalizePoppedCrossDomainMessage(uint256 newIndex) external;
}
```

---

*Document Version: 1.0*
*Last Updated: December 2025*
*Based on: DRAFT_TEE_SPECS.md (L1 contract architecture sections)*

