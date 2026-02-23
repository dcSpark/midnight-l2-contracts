/* eslint-env node */
import { type ContractState, createCircuitContext } from '@midnight-ntwrk/compact-runtime';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { assertIsContractAddress } from '@midnight-ntwrk/midnight-js-utils';
import { Bridge, type BridgePrivateState, witnesses } from 'bridge-contract/browser';
import { Console } from 'node:console';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { stderr, stdout } from 'node:process';
import { WebSocket } from 'ws';
import * as api from './api';
import type { DeployedBridgeContract } from './common-types';
import { type Config, PreviewConfig, UndeployedConfig, currentDir } from './config';
import { createLogger } from './logger';

const console = new Console({ stdout, stderr });
globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

type L1_BatchPublicDataV1Full = Bridge.L1_BatchPublicDataV1Full;
type Signature = Bridge.Signature;

type L1ToL2DepositMessage = {
  sender: Uint8Array;
  recipient: Uint8Array;
  amount: bigint;
  nonce: bigint;
  gasLimit: bigint;
  dataHash: Uint8Array;
};

const DEFAULT_CONTRACT_ADDRESS =
  process.env.DEFAULT_BRIDGE_ADDRESS ?? 'fa8533250190a9d2b39686523e7b13e7dc30647a341f8163dceaec2cdc365f12';
const { config: baseConfig, label: configLabel } = resolveNetworkConfig();
const INDEXER_HTTP = process.env.INDEXER_HTTP ?? baseConfig.indexer;
const INDEXER_WS = process.env.INDEXER_WS ?? baseConfig.indexerWS;
const provider = indexerPublicDataProvider(INDEXER_HTTP, INDEXER_WS);
const ZERO_COIN_PUBLIC_KEY = '0'.repeat(64);
const defaultPrivateState: BridgePrivateState = { privateState: 0 };
const GENESIS_MINT_WALLET_SEED = '0000000000000000000000000000000000000000000000000000000000000001';
const DEFAULT_VERIFIER_SECRET_KEYS = [101n, 102n, 103n] as const;
const DEFAULT_SIGNER_BITMAP = (1n << BigInt(DEFAULT_VERIFIER_SECRET_KEYS.length)) - 1n;
const SIGNATURE_NONCE = 0n;
const DEFAULT_SIGNATURE_MAX_NONCE = 256n;

type PublicDataProvider = ReturnType<typeof indexerPublicDataProvider>;

type NetworkPreference = 'preview' | 'undeployed';

function resolveNetworkConfig(): { config: Config; label: string } {
  const envPreference = (process.env.MIDNIGHT_NETWORK ?? process.env.MIDNIGHT_ENV ?? '').trim().toLowerCase();
  if (envPreference.length === 0) {
    return { config: new PreviewConfig(), label: 'preview (default)' };
  }

  const map: Record<string, NetworkPreference> = {
    preview: 'preview',
    undeployed: 'undeployed',
    local: 'undeployed',
    standalone: 'undeployed',
    dev: 'undeployed',
  };

  const preference = map[envPreference];
  if (preference === 'undeployed') {
    return { config: new UndeployedConfig(), label: 'undeployed/local' };
  }
  if (preference === 'preview') {
    return { config: new PreviewConfig(), label: 'preview' };
  }

  console.warn(`Unknown MIDNIGHT_NETWORK value "${envPreference}". Falling back to preview settings.`);
  return { config: new PreviewConfig(), label: 'preview (fallback)' };
}

async function main() {
  const contractAddress = process.env.BRIDGE_CONTRACT_ADDRESS ?? DEFAULT_CONTRACT_ADDRESS;
  assertIsContractAddress(contractAddress);
  console.log('Querying Bridge contract at address:', contractAddress);
  console.log('Network preset:', configLabel);
  console.log('Indexer (HTTP/WS):', INDEXER_HTTP, INDEXER_WS);

  const contractState = await provider.queryContractState(contractAddress);
  if (!contractState) {
    throw new Error('No state found for contract');
  }

  const contract = new Bridge.Contract<BridgePrivateState>(witnesses);
  const ledger = Bridge.ledger(contractState.data);
  const lastFinalizedBatchIndex = ledger.L1_miscData.lastFinalizedBatchIndex;
  const lastCommittedBatchIndex = ledger.L1_miscData.lastCommittedBatchIndex;
  const nextIndex = ledger.L1_nextCrossDomainMessageIndex;

  let rollingHashAtNextIndex: Uint8Array | undefined;
  const rollingHashIndex = nextIndex > 0n ? nextIndex - 1n : 0n;
  if (ledger.L1_messageRollingHashes.member(rollingHashIndex)) {
    rollingHashAtNextIndex = ledger.L1_messageRollingHashes.lookup(rollingHashIndex);
  }
  console.log('Next cross-domain message index:', nextIndex.toString());
  if (rollingHashAtNextIndex) {
    console.log('Rolling hash at latest index:', toHex(rollingHashAtNextIndex));
  }
  console.log('Last committed batch index:', lastCommittedBatchIndex.toString());
  console.log('Last finalized batch index:', lastFinalizedBatchIndex.toString());

  const deposits = new Map<bigint, L1ToL2DepositMessage>();
  const fetchAndCache = (queueIndex: bigint): L1ToL2DepositMessage | undefined => {
    if (deposits.has(queueIndex)) {
      return deposits.get(queueIndex);
    }
    if (!ledger.L1_l1ToL2Deposits.member(queueIndex)) {
      return undefined;
    }
    const deposit = ledger.L1_l1ToL2Deposits.lookup(queueIndex);
    deposits.set(queueIndex, deposit);
    return deposit;
  };

  console.log('---');
  console.log('Iterating over all deposits (0 → nextIndex-1):');
  let total = 0;
  for (let idx = 0n; idx < nextIndex; idx += 1n) {
    const deposit = fetchAndCache(idx);
    if (!deposit) {
      continue;
    }
    console.log(`Key ${idx.toString()}:`, formatDeposit(deposit));
    total += 1;
  }
  if (total === 0) {
    console.log('Map is empty');
  } else {
    console.log(`Displayed ${total} entries (up to index ${nextIndex - 1n}).`);
  }

  await maybeSubmitDummyBatch({
    contract,
    contractAddress,
    config: baseConfig,
    publicDataProvider: provider,
  });
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function formatDeposit(deposit: L1ToL2DepositMessage) {
  return {
    sender: toHex(deposit.sender),
    recipient: toHex(deposit.recipient),
    amount: deposit.amount.toString(),
    nonce: deposit.nonce.toString(),
    gasLimit: deposit.gasLimit.toString(),
    dataHash: toHex(deposit.dataHash),
  };
}

type SubmitBatchParams = {
  contract: Bridge.Contract<BridgePrivateState>;
  contractAddress: string;
  config: Config;
  publicDataProvider: PublicDataProvider;
};

type EnsureBatchParams = SubmitBatchParams & {
  bridgeContract: DeployedBridgeContract;
  publicDataProvider: PublicDataProvider;
};

type BatchDataParams = {
  contract: Bridge.Contract<BridgePrivateState>;
  contractAddress: string;
  contractState: ContractState;
  ledger: Bridge.Ledger;
  batchHash: Uint8Array;
};

const deriveDefaultVerifierSet = () => DEFAULT_VERIFIER_SECRET_KEYS.map((sk) => Bridge.pureCircuits.derivePk(sk));

const shouldResetVerifierSet = (): boolean => {
  const raw = (process.env.TEST_DECODE_RESET_VERIFIER_SET ?? 'true').trim().toLowerCase();
  if (raw === 'false' || raw === '0') {
    return false;
  }
  return true;
};

async function ensureDefaultVerifierSet(bridgeContract: DeployedBridgeContract): Promise<void> {
  if (!shouldResetVerifierSet()) {
    console.log('Skipping verifier set reset (TEST_DECODE_RESET_VERIFIER_SET=false).');
    return;
  }
  console.log('Ensuring verifier set matches known development keys...');
  const tx = await bridgeContract.callTx.setVerifierSet(deriveDefaultVerifierSet());
  console.log('setVerifierSet txHash:', tx.public.txHash);
}

async function maybeSubmitDummyBatch(params: SubmitBatchParams): Promise<void> {
  const skipFlag = (process.env.TEST_DECODE_SKIP_BATCH ?? '').trim().toLowerCase();
  if (skipFlag === '1' || skipFlag === 'true') {
    console.log('Skipping dummy batch submission because TEST_DECODE_SKIP_BATCH is set.');
    return;
  }
  if (!(params.config instanceof UndeployedConfig)) {
    console.log('Skipping dummy batch submission (only supported on undeployed/local networks).');
    return;
  }
  await submitDummyBatch(params);
}

async function submitDummyBatch(params: SubmitBatchParams): Promise<void> {
  console.log('---');
  console.log('Preparing dummy batch to exercise commitBatch/finalizeBatch...');

  const logPath = path.resolve(currentDir, '..', 'logs', 'test-decode', `${new Date().toISOString()}.log`);
  const logger = await createLogger(logPath);
  api.setLogger(logger);

  const walletSeed = process.env.TEST_DECODE_WALLET_HEX_SEED ?? GENESIS_MINT_WALLET_SEED;
  let walletContext: api.WalletContext | null = null;
  try {
    walletContext = await api.buildWalletFromHexSeed(params.config, walletSeed);
    const providers = await api.configureProviders(walletContext, params.config);
    const poller = providers.publicDataProvider ?? params.publicDataProvider;
    if (!poller) {
      throw new Error('Public data provider is not available');
    }
    const bridgeContract = await api.joinContract(providers, params.contractAddress);
    await ensureDefaultVerifierSet(bridgeContract);
    const { contractState: pendingContractState, ledger: pendingLedger, batchHash } = await ensurePendingBatch({
      ...params,
      bridgeContract,
      publicDataProvider: poller,
    });

    const targetBatchIndex = pendingLedger.L1_miscData.lastFinalizedBatchIndex + 1n;
    if (pendingLedger.L1_miscData.lastCommittedBatchIndex < targetBatchIndex) {
      throw new Error('No committed batch available to finalize.');
    }

    const batchData = await buildBatchPublicData({
      contract: params.contract,
      contractAddress: params.contractAddress,
      contractState: pendingContractState,
      ledger: pendingLedger,
      batchHash,
    });

    const digest = hashBatchPublicDataV1Full(batchData);
    const signatures = buildSignatureVector(digest);
    console.log('Signature[0] types:', typeof signatures[0].pk.x, typeof signatures[0].r.x, typeof signatures[0].s);
    console.log('Signature[0] value:', signatures[0]);
    signatures.forEach((signature, index) => {
      try {
        const valid = Bridge.pureCircuits.verifyBytes32(digest, signature);
        console.log(`Local signature verification (signer ${index}):`, valid);
      } catch (verifyError) {
        console.error(`Local verifyBytes32 failed for signer ${index}:`, verifyError);
      }
    });
    try {
      const dryRunContext = createCircuitContext(
        params.contractAddress,
        ZERO_COIN_PUBLIC_KEY,
        pendingContractState,
        defaultPrivateState,
      );
      params.contract.circuits.finalizeBatch(dryRunContext, batchData, signatures, DEFAULT_SIGNER_BITMAP, 0n);
      console.log('Dry-run finalizeBatch succeeded in pure circuit context.');
    } catch (dryRunError) {
      console.error('Dry-run finalizeBatch failed:', dryRunError);
    }
    const finalizeTx = await bridgeContract.callTx.finalizeBatch(batchData, signatures, DEFAULT_SIGNER_BITMAP, 0n);
    console.log('finalizeBatch txHash:', finalizeTx.public.txHash);

    await waitForBatchIndexUpdate(
      poller,
      params.contract,
      params.contractAddress,
      (ledger) => ledger.L1_miscData.lastFinalizedBatchIndex >= targetBatchIndex,
      'lastFinalizedBatchIndex',
    );

    const { ledger: finalLedger } = await getContractStateAndLedger(poller, params.contractAddress);
    console.log('Dummy batch finalized at index:', finalLedger.L1_miscData.lastFinalizedBatchIndex.toString());
  } finally {
    if (walletContext) {
      await api.closeWallet(walletContext);
    }
  }
}

async function getContractStateAndLedger(
  publicDataProvider: PublicDataProvider,
  contractAddress: string,
): Promise<{ contractState: ContractState; ledger: Bridge.Ledger }> {
  const contractState = await publicDataProvider.queryContractState(contractAddress);
  if (!contractState) {
    throw new Error('No state found for contract');
  }
  return { contractState, ledger: Bridge.ledger(contractState.data) };
}

async function ensurePendingBatch(
  params: EnsureBatchParams,
): Promise<{ contractState: ContractState; ledger: Bridge.Ledger; batchHash: Uint8Array }> {
  const { contractState: initialContractState, ledger: initialLedger } = await getContractStateAndLedger(
    params.publicDataProvider,
    params.contractAddress,
  );
  const hasPending = initialLedger.L1_miscData.lastCommittedBatchIndex > initialLedger.L1_miscData.lastFinalizedBatchIndex;
  const targetBatchIndex = initialLedger.L1_miscData.lastFinalizedBatchIndex + 1n;

  if (hasPending) {
    const existingHash = await readCommittedBatch(
      params.contract,
      params.contractAddress,
      initialContractState,
      targetBatchIndex,
    );
    console.log('Found existing unfinalized batch. Reusing batch hash:', toHex(existingHash));
    return { contractState: initialContractState, ledger: initialLedger, batchHash: existingHash };
  }

  const parentHash = await readCommittedBatch(
    params.contract,
    params.contractAddress,
    initialContractState,
    initialLedger.L1_miscData.lastCommittedBatchIndex,
  );
  const newBatchHash = randomBytes32();
  const commitTx = await params.bridgeContract.callTx.commitBatch(parentHash, newBatchHash);
  console.log('commitBatch txHash:', commitTx.public.txHash);
  console.log('Dummy batch hash:', toHex(newBatchHash));

  const updated = await waitForBatchIndexUpdate(
    params.publicDataProvider,
    params.contract,
    params.contractAddress,
    (ledger) => ledger.L1_miscData.lastCommittedBatchIndex >= targetBatchIndex,
    'lastCommittedBatchIndex',
  );

  return { contractState: updated.contractState, ledger: updated.ledger, batchHash: newBatchHash };
}

async function buildBatchPublicData(params: BatchDataParams): Promise<L1_BatchPublicDataV1Full> {
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
  const messageQueueHash = ledgerState.L1_messageRollingHashes.member(lastProcessedQueueIndex)
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

function computeLastProcessedQueueIndex(ledger: Bridge.Ledger): bigint {
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

async function waitForBatchIndexUpdate(
  publicDataProvider: PublicDataProvider,
  _contract: Bridge.Contract<BridgePrivateState>,
  contractAddress: string,
  predicate: (ledger: Bridge.Ledger) => boolean,
  label: string,
  attempts = 20,
  delayMs = 3_000,
): Promise<{ contractState: ContractState; ledger: Bridge.Ledger }> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { contractState, ledger } = await getContractStateAndLedger(publicDataProvider, contractAddress);
    if (predicate(ledger)) {
      return { contractState, ledger };
    }
    await delay(delayMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readCommittedBatch(
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

function randomBytes32(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

function buildSignatureVector(digest: Uint8Array): Signature[] {
  return DEFAULT_VERIFIER_SECRET_KEYS.map((sk, index) =>
    signWithNonceRetry(digest, sk, index, getSignatureNonceSearchLimit()),
  );
}

function getSignatureNonceSearchLimit(): bigint {
  const raw = (process.env.TEST_DECODE_SIGNATURE_MAX_NONCE ?? '').trim();
  if (raw.length === 0) {
    return DEFAULT_SIGNATURE_MAX_NONCE;
  }
  const parsed = BigInt(raw);
  if (parsed <= 0n) {
    throw new Error('TEST_DECODE_SIGNATURE_MAX_NONCE must be positive if provided');
  }
  return parsed;
}

function signWithNonceRetry(digest: Uint8Array, secretKey: bigint, signerIndex: number, limit: bigint): Signature {
  let lastError: unknown = null;
  for (let nonce = SIGNATURE_NONCE; nonce < limit; nonce += 1n) {
    try {
      const signature = Bridge.pureCircuits.signBytes32(digest, secretKey, nonce) as Signature;
      const valid = Bridge.pureCircuits.verifyBytes32(digest, signature) as boolean;
      if (valid) {
        console.log(`Signer ${signerIndex} produced signature with nonce=${nonce.toString()}.`);
        return signature;
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) {
    console.error(`Signature generation repeatedly failed for signer ${signerIndex}. Last error:`, lastError);
  }
  throw new Error(
    `Unable to produce a valid signature for signer ${signerIndex} after scanning ${limit.toString()} nonces.`,
  );
}

const BATCH_DOMAIN = strictPadBytes32Local('mdn:bpd:v1full');
function hashBatchPublicDataV1Full(b: L1_BatchPublicDataV1Full): Uint8Array {
  const chunks = [
    BATCH_DOMAIN,
    uToBytes32LELocal(b.version),
    uToBytes32LELocal(b.layer2ChainId),
    ensureBytes32Length(b.rollupId, 'rollupId'),
    uToBytes32LELocal(b.batchIndex),
    uToBytes32LELocal(b.daStartHeight),
    uToBytes32LELocal(b.daEndHeight),
    ensureBytes32Length(b.daCommitment, 'daCommitment'),
    uToBytes32LELocal(b.lastProcessedQueueIndex),
    ensureBytes32Length(b.messageQueueHash, 'messageQueueHash'),
    ensureBytes32Length(b.prevStateRoot, 'prevStateRoot'),
    ensureBytes32Length(b.prevBatchHash, 'prevBatchHash'),
    ensureBytes32Length(b.postStateRoot, 'postStateRoot'),
    ensureBytes32Length(b.batchHash, 'batchHash'),
    ensureBytes32Length(b.withdrawRoot, 'withdrawRoot'),
  ];
  return sha256Local(concatBytes32ChunksLocal(chunks));
}

function strictPadBytes32Local(value: string): Uint8Array {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > 32) {
    throw new Error(`Value '${value}' exceeds 32 bytes.`);
  }
  const out = new Uint8Array(32);
  out.set(bytes);
  return out;
}

function uToBytes32LELocal(value: bigint): Uint8Array {
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

function concatBytes32ChunksLocal(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.length * 32);
  chunks.forEach((chunk, index) => {
    if (chunk.length !== 32) {
      throw new Error(`Chunk at position ${index} must be 32 bytes (got ${chunk.length})`);
    }
    out.set(chunk, index * 32);
  });
  return out;
}

function sha256Local(data: Uint8Array): Uint8Array {
  const hash = createHash('sha256');
  hash.update(data);
  return new Uint8Array(hash.digest());
}

function ensureBytes32Length(value: Uint8Array, label: string): Uint8Array {
  if (value.length !== 32) {
    throw new Error(`${label} must be 32 bytes (got ${value.length})`);
  }
  return value;
}

function zeroBytes32(): Uint8Array {
  return new Uint8Array(32);
}

void main().catch((error) => {
  console.error('Failed to decode l1ToL2Deposits via circuit call:', error);
  process.exitCode = 1;
});
