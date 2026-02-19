/**
 * Shared batch and signature helpers for finalize-batch and test-decode.
 * Extracted from test-decode.ts.
 */
import { type ContractState } from '@midnight-ntwrk/compact-runtime';
import { createHash, randomBytes } from 'node:crypto';
import { Bridge, type BridgePrivateState } from 'bridge-contract/browser';
import type { DeployedBridgeContract } from './common-types.js';

export type L1_BatchPublicDataV1Full = Bridge.L1_BatchPublicDataV1Full;
export type Signature = Bridge.Signature;
export type BridgeLedger = ReturnType<typeof Bridge.ledger>;

export const DEFAULT_VERIFIER_SECRET_KEYS = [101n, 102n, 103n] as const;
export const DEFAULT_SIGNER_BITMAP =
  (1n << BigInt(DEFAULT_VERIFIER_SECRET_KEYS.length)) - 1n;
const SIGNATURE_NONCE = 0n;
const DEFAULT_SIGNATURE_MAX_NONCE = 256n;

export type PublicDataProvider = {
  queryContractState: (address: string) => Promise<ContractState | null>;
};

export async function getContractStateAndLedger(
  publicDataProvider: PublicDataProvider,
  contractAddress: string,
): Promise<{ contractState: ContractState; ledger: BridgeLedger }> {
  const contractState = await publicDataProvider.queryContractState(contractAddress);
  if (!contractState) {
    throw new Error('No state found for contract');
  }
  return { contractState, ledger: Bridge.ledger(contractState.data) };
}

export function randomBytes32(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

export function zeroBytes32(): Uint8Array {
  return new Uint8Array(32);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readCommittedBatch(
  _contract: Bridge.Contract<BridgePrivateState>,
  _contractAddress: string,
  contractState: ContractState,
  index: bigint,
): Promise<Uint8Array> {
  const ledger = Bridge.ledger(contractState.data);
  if (!ledger.L1_committedBatches.member(index)) {
    throw new Error(`Committed batch not found for index ${index}`);
  }
  return ledger.L1_committedBatches.lookup(index);
}

export async function waitForBatchIndexUpdate(
  publicDataProvider: PublicDataProvider,
  _contract: Bridge.Contract<BridgePrivateState>,
  contractAddress: string,
  predicate: (ledger: BridgeLedger) => boolean,
  label: string,
  attempts = 20,
  delayMs = 3_000,
): Promise<{ contractState: ContractState; ledger: BridgeLedger }> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { contractState, ledger } = await getContractStateAndLedger(
      publicDataProvider,
      contractAddress,
    );
    if (predicate(ledger)) {
      return { contractState, ledger };
    }
    await delay(delayMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export type EnsureBatchParams = {
  contract: Bridge.Contract<BridgePrivateState>;
  contractAddress: string;
  bridgeContract: DeployedBridgeContract;
  publicDataProvider: PublicDataProvider;
};

export async function ensurePendingBatch(params: EnsureBatchParams): Promise<{
  contractState: ContractState;
  ledger: BridgeLedger;
  batchHash: Uint8Array;
}> {
  const { contractState: initialContractState, ledger: initialLedger } =
    await getContractStateAndLedger(
      params.publicDataProvider,
      params.contractAddress,
    );
  const hasPending =
    initialLedger.L1_miscData.lastCommittedBatchIndex >
    initialLedger.L1_miscData.lastFinalizedBatchIndex;
  const targetBatchIndex = initialLedger.L1_miscData.lastFinalizedBatchIndex + 1n;

  if (hasPending) {
    const existingHash = await readCommittedBatch(
      params.contract,
      params.contractAddress,
      initialContractState,
      targetBatchIndex,
    );
    return {
      contractState: initialContractState,
      ledger: initialLedger,
      batchHash: existingHash,
    };
  }

  const parentHash = await readCommittedBatch(
    params.contract,
    params.contractAddress,
    initialContractState,
    initialLedger.L1_miscData.lastCommittedBatchIndex,
  );
  const newBatchHash = randomBytes32();
  await params.bridgeContract.callTx.commitBatch(parentHash, newBatchHash);

  const updated = await waitForBatchIndexUpdate(
    params.publicDataProvider,
    params.contract,
    params.contractAddress,
    (ledger) => ledger.L1_miscData.lastCommittedBatchIndex >= targetBatchIndex,
    'lastCommittedBatchIndex',
  );

  return {
    contractState: updated.contractState,
    ledger: updated.ledger,
    batchHash: newBatchHash,
  };
}

export type BatchDataParams = {
  contract: Bridge.Contract<BridgePrivateState>;
  contractAddress: string;
  contractState: ContractState;
  ledger: BridgeLedger;
  batchHash: Uint8Array;
};

export function computeLastProcessedQueueIndex(ledger: BridgeLedger): bigint {
  if (ledger.L1_nextCrossDomainMessageIndex === 0n) {
    return 0n;
  }
  const candidate = ledger.L1_nextCrossDomainMessageIndex - 1n;
  if (ledger.L1_nextUnfinalizedQueueIndex === 0n) {
    return candidate;
  }
  const minimum = ledger.L1_nextUnfinalizedQueueIndex - 1n;
  return candidate > minimum ? candidate : minimum;
}

export async function buildBatchPublicData(
  params: BatchDataParams,
): Promise<L1_BatchPublicDataV1Full> {
  const prevBatchIndex = params.ledger.L1_miscData.lastFinalizedBatchIndex;
  const batchIndex = prevBatchIndex + 1n;
  const ledgerState = params.ledger;
  if (!ledgerState.L1_committedBatches.member(prevBatchIndex)) {
    throw new Error(`Committed batch not found for index ${prevBatchIndex}`);
  }
  if (!ledgerState.L1_finalizedStateRoots.member(prevBatchIndex)) {
    throw new Error(`Finalized state root not found for index ${prevBatchIndex}`);
  }
  const prevBatchHash = ledgerState.L1_committedBatches.lookup(prevBatchIndex);
  const prevStateRoot = ledgerState.L1_finalizedStateRoots.lookup(prevBatchIndex);
  const lastProcessedQueueIndex = computeLastProcessedQueueIndex(params.ledger);
  const messageQueueHash = ledgerState.L1_messageRollingHashes.member(
    lastProcessedQueueIndex,
  )
    ? ledgerState.L1_messageRollingHashes.lookup(lastProcessedQueueIndex)
    : zeroBytes32();

  return {
    version: 1n,
    layer2ChainId: 0n,
    rollupId: zeroBytes32(),
    batchIndex,
    daStartHeight: 0n,
    daEndHeight: 0n,
    daCommitment: zeroBytes32(),
    lastProcessedQueueIndex,
    messageQueueHash,
    prevStateRoot,
    prevBatchHash,
    postStateRoot: randomBytes32(),
    batchHash: params.batchHash,
    withdrawRoot: randomBytes32(),
  } satisfies L1_BatchPublicDataV1Full;
}

function getSignatureNonceSearchLimit(): bigint {
  const raw = (
    process.env.TEST_DECODE_SIGNATURE_MAX_NONCE ??
    process.env.SIGNATURE_MAX_NONCE ??
    ''
  ).trim();
  if (raw.length === 0) {
    return DEFAULT_SIGNATURE_MAX_NONCE;
  }
  const parsed = BigInt(raw);
  if (parsed <= 0n) {
    throw new Error('SIGNATURE_MAX_NONCE must be positive if provided');
  }
  return parsed;
}

function signWithNonceRetry(
  digest: Uint8Array,
  secretKey: bigint,
  signerIndex: number,
  limit: bigint,
): Signature {
  let lastError: unknown = null;
  for (let nonce = SIGNATURE_NONCE; nonce < limit; nonce += 1n) {
    try {
      const signature = Bridge.pureCircuits.signBytes32(
        digest,
        secretKey,
        nonce,
      ) as Signature;
      const valid = Bridge.pureCircuits.verifyBytes32(
        digest,
        signature,
      ) as boolean;
      if (valid) {
        return signature;
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) {
    throw new Error(
      `Unable to produce a valid signature for signer ${signerIndex} after scanning ${limit.toString()} nonces. Last error: ${lastError}`,
    );
  }
  throw new Error(
    `Unable to produce a valid signature for signer ${signerIndex} after scanning ${limit.toString()} nonces.`,
  );
}

export function buildSignatureVector(
  digest: Uint8Array,
  maxNonce?: bigint,
): Signature[] {
  const limit = maxNonce ?? getSignatureNonceSearchLimit();
  return DEFAULT_VERIFIER_SECRET_KEYS.map((sk, index) =>
    signWithNonceRetry(digest, sk, index, limit),
  );
}

function strictPadBytes32(value: string): Uint8Array {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > 32) {
    throw new Error(`Value '${value}' exceeds 32 bytes.`);
  }
  const out = new Uint8Array(32);
  out.set(bytes);
  return out;
}

function uToBytes32LE(value: bigint): Uint8Array {
  if (value < 0n) {
    throw new Error('Negative values are not supported');
  }
  const out = new Uint8Array(32);
  let current = value;
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number(current & 0xffn);
    current >>= 8n;
  }
  if (current !== 0n) {
    throw new Error('Integer does not fit in 32 bytes');
  }
  return out;
}

function ensureBytes32Length(value: Uint8Array, label: string): Uint8Array {
  if (value.length !== 32) {
    throw new Error(`${label} must be 32 bytes (got ${value.length})`);
  }
  return value;
}

function concatBytes32Chunks(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.length * 32);
  chunks.forEach((chunk, index) => {
    if (chunk.length !== 32) {
      throw new Error(
        `Chunk at position ${index} must be 32 bytes (got ${chunk.length})`,
      );
    }
    out.set(chunk, index * 32);
  });
  return out;
}

function sha256(data: Uint8Array): Uint8Array {
  const hash = createHash('sha256');
  hash.update(data);
  return new Uint8Array(hash.digest());
}

const BATCH_DOMAIN = strictPadBytes32('mdn:bpd:v1full');

export function hashBatchPublicDataV1Full(b: L1_BatchPublicDataV1Full): Uint8Array {
  const chunks = [
    BATCH_DOMAIN,
    uToBytes32LE(b.version),
    uToBytes32LE(b.layer2ChainId),
    ensureBytes32Length(b.rollupId, 'rollupId'),
    uToBytes32LE(b.batchIndex),
    uToBytes32LE(b.daStartHeight),
    uToBytes32LE(b.daEndHeight),
    ensureBytes32Length(b.daCommitment, 'daCommitment'),
    uToBytes32LE(b.lastProcessedQueueIndex),
    ensureBytes32Length(b.messageQueueHash, 'messageQueueHash'),
    ensureBytes32Length(b.prevStateRoot, 'prevStateRoot'),
    ensureBytes32Length(b.prevBatchHash, 'prevBatchHash'),
    ensureBytes32Length(b.postStateRoot, 'postStateRoot'),
    ensureBytes32Length(b.batchHash, 'batchHash'),
    ensureBytes32Length(b.withdrawRoot, 'withdrawRoot'),
  ];
  return sha256(concatBytes32Chunks(chunks));
}

export function deriveDefaultVerifierSet(): ReturnType<typeof Bridge.pureCircuits.derivePk>[] {
  return DEFAULT_VERIFIER_SECRET_KEYS.map((sk) =>
    Bridge.pureCircuits.derivePk(sk),
  );
}

/** Parse 64-char hex (optionally 0x-prefixed) to 32 bytes. */
export function hexToBytes32(hex: string): Uint8Array {
  const s = hex.replace(/^0x/, '').trim();
  if (s.length !== 64 || !/^[0-9a-fA-F]+$/.test(s)) {
    throw new Error('Must be 32 bytes (64 hex chars)');
  }
  return new Uint8Array(Buffer.from(s, 'hex'));
}

/** Encode 32 bytes to 64-char hex (no 0x prefix). */
export function bytes32ToHex(bytes: Uint8Array): string {
  if (bytes.length !== 32) {
    throw new Error(`Expected 32 bytes, got ${bytes.length}`);
  }
  return Buffer.from(bytes).toString('hex');
}

/** Parse a JSON-serializable value to bigint (string or number). */
function parseJsonBigInt(value: unknown, field: string): bigint {
  if (typeof value === 'string') {
    const n = BigInt(value);
    if (n < 0n) throw new Error(`${field} must be non-negative`);
    return n;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new Error(`${field} must be a non-negative integer (string or number)`);
}

/** Parse JSON object with x,y (bigint) for curve points. */
function parsePoint(obj: unknown, field: string): { x: bigint; y: bigint } {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`${field} must be an object { x, y }`);
  }
  const o = obj as Record<string, unknown>;
  return {
    x: parseJsonBigInt(o.x, `${field}.x`),
    y: parseJsonBigInt(o.y, `${field}.y`),
  };
}

/**
 * Parse L1_BatchPublicDataV1Full from a JSON string.
 * Bytes<32> fields must be 64-char hex (optional 0x prefix). Numeric fields as string or number.
 */
export function parseBatchPublicDataFromJson(json: string): L1_BatchPublicDataV1Full {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`Invalid JSON for batch public data: ${e}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('batch public data must be a JSON object');
  }
  const o = raw as Record<string, unknown>;
  const bytes32 = (key: string): Uint8Array => {
    const v = o[key];
    if (typeof v !== 'string') throw new Error(`${key} must be 64 hex chars`);
    return hexToBytes32(v);
  };
  return {
    version: parseJsonBigInt(o.version ?? 1, 'version'),
    layer2ChainId: parseJsonBigInt(o.layer2ChainId ?? 0, 'layer2ChainId'),
    rollupId: o.rollupId !== undefined ? bytes32('rollupId') : zeroBytes32(),
    batchIndex: parseJsonBigInt(o.batchIndex, 'batchIndex'),
    daStartHeight: parseJsonBigInt(o.daStartHeight ?? 0, 'daStartHeight'),
    daEndHeight: parseJsonBigInt(o.daEndHeight ?? 0, 'daEndHeight'),
    daCommitment: o.daCommitment !== undefined ? bytes32('daCommitment') : zeroBytes32(),
    lastProcessedQueueIndex: parseJsonBigInt(o.lastProcessedQueueIndex, 'lastProcessedQueueIndex'),
    messageQueueHash: bytes32('messageQueueHash'),
    prevStateRoot: bytes32('prevStateRoot'),
    prevBatchHash: bytes32('prevBatchHash'),
    postStateRoot: bytes32('postStateRoot'),
    batchHash: bytes32('batchHash'),
    withdrawRoot: bytes32('withdrawRoot'),
  } satisfies L1_BatchPublicDataV1Full;
}

/**
 * Parse Signature[] from a JSON string. Must be an array of exactly 3 Signature.
 * Each Signature: { pk: { x, y }, r: { x, y }, s } with bigints as strings or numbers.
 */
export function parseSignaturesFromJson(json: string): Signature[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`Invalid JSON for signatures: ${e}`);
  }
  if (!Array.isArray(raw) || raw.length !== 3) {
    throw new Error('signatures must be a JSON array of exactly 3 elements');
  }
  return raw.map((item, i) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`signatures[${i}] must be an object { pk, r, s }`);
    }
    const s = item as Record<string, unknown>;
    return {
      pk: parsePoint(s.pk, `signatures[${i}].pk`),
      r: parsePoint(s.r, `signatures[${i}].r`),
      s: parseJsonBigInt(s.s, `signatures[${i}].s`),
    } as Signature;
  });
}

/**
 * Serialize L1_BatchPublicDataV1Full to JSON (for callers that build args and pass to CLI).
 * Bytes as 64-char hex; bigints as decimal strings.
 */
export function batchPublicDataToJson(b: L1_BatchPublicDataV1Full): string {
  return JSON.stringify({
    version: b.version.toString(),
    layer2ChainId: b.layer2ChainId.toString(),
    rollupId: bytes32ToHex(b.rollupId),
    batchIndex: b.batchIndex.toString(),
    daStartHeight: b.daStartHeight.toString(),
    daEndHeight: b.daEndHeight.toString(),
    daCommitment: bytes32ToHex(b.daCommitment),
    lastProcessedQueueIndex: b.lastProcessedQueueIndex.toString(),
    messageQueueHash: bytes32ToHex(b.messageQueueHash),
    prevStateRoot: bytes32ToHex(b.prevStateRoot),
    prevBatchHash: bytes32ToHex(b.prevBatchHash),
    postStateRoot: bytes32ToHex(b.postStateRoot),
    batchHash: bytes32ToHex(b.batchHash),
    withdrawRoot: bytes32ToHex(b.withdrawRoot),
  });
}

/**
 * Serialize Signature[] to JSON (for callers that build args and pass to CLI).
 */
export function signaturesToJson(sigs: Signature[]): string {
  if (sigs.length !== 3) {
    throw new Error('signatures must have exactly 3 elements');
  }
  return JSON.stringify(
    sigs.map((sig) => ({
      pk: { x: sig.pk.x.toString(), y: sig.pk.y.toString() },
      r: { x: sig.r.x.toString(), y: sig.r.y.toString() },
      s: sig.s.toString(),
    })),
  );
}

/**
 * Build L1_BatchPublicDataV1Full from explicitly provided values (for finalize-batch CLI).
 * All hashes are 64-char hex; indices are bigint or decimal string.
 */
export type ExplicitBatchDataParams = {
  batchIndex: bigint;
  prevStateRoot: Uint8Array;
  prevBatchHash: Uint8Array;
  batchHash: Uint8Array;
  postStateRoot: Uint8Array;
  withdrawRoot: Uint8Array;
  lastProcessedQueueIndex: bigint;
  messageQueueHash: Uint8Array;
  version?: bigint;
  layer2ChainId?: bigint;
  rollupId?: Uint8Array;
  daStartHeight?: bigint;
  daEndHeight?: bigint;
  daCommitment?: Uint8Array;
};

export function buildBatchPublicDataFromExplicit(
  params: ExplicitBatchDataParams,
): L1_BatchPublicDataV1Full {
  return {
    version: params.version ?? 1n,
    layer2ChainId: params.layer2ChainId ?? 0n,
    rollupId: params.rollupId ?? zeroBytes32(),
    batchIndex: params.batchIndex,
    daStartHeight: params.daStartHeight ?? 0n,
    daEndHeight: params.daEndHeight ?? 0n,
    daCommitment: params.daCommitment ?? zeroBytes32(),
    lastProcessedQueueIndex: params.lastProcessedQueueIndex,
    messageQueueHash: params.messageQueueHash,
    prevStateRoot: params.prevStateRoot,
    prevBatchHash: params.prevBatchHash,
    postStateRoot: params.postStateRoot,
    batchHash: params.batchHash,
    withdrawRoot: params.withdrawRoot,
  } satisfies L1_BatchPublicDataV1Full;
}
