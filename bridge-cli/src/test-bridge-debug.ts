/* eslint-env node */
/*
BRIDGE_ADDRESS=02496a47d36653386f05e05e6fc0172f41777489df2b8a3a8788f466e3cbbb0e \
MIDNIGHT_NETWORK=undeployed \
npx --yes tsx --tsconfig tsconfig.json src/test-bridge-debug.ts
*/
import { CompiledContract, getImpureCircuitIds, type ImpureCircuitId } from '@midnight-ntwrk/compact-js';
import {
  ContractState,
  createCircuitContext,
  encodeCoinPublicKey,
  sampleSigningKey,
  type WitnessContext,
} from '@midnight-ntwrk/compact-runtime';
import type { FinalizedTransaction, UnprovenTransaction } from '@midnight-ntwrk/ledger-v7';
import {
  type CallTxOptionsWithPrivateStateId,
  createCallTxOptions,
  createCircuitCallTxInterface,
  createUnprovenCallTx,
  createUnprovenDeployTxFromVerifierKeys,
  DeployTxFailedError,
  submitTx,
} from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { getNetworkId, setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import {
  type MidnightProvider,
  type MidnightProviders,
  type ProofProvider,
  SucceedEntirely,
  type WalletProvider,
} from '@midnight-ntwrk/midnight-js-types';
import { assertIsContractAddress, parseCoinPublicKeyToHex } from '@midnight-ntwrk/midnight-js-utils';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { BridgeDebug } from 'bridge-contract/browser';
import { Console } from 'node:console';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { stderr, stdout } from 'node:process';
import { WebSocket } from 'ws';
import * as api from './api';
import { type Config, currentDir, PreviewConfig, UndeployedConfig } from './config';
import { createLogger } from './logger';

const console = new Console({ stdout, stderr });
globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

type L1_BatchPublicDataV1Full = BridgeDebug.L1_BatchPublicDataV1Full;
type Signature = BridgeDebug.Signature;
type BridgeDebugLedger = BridgeDebug.Ledger;

type BridgeDebugPrivateState = {
  privateState: number;
};

function computeBitmapBits(bitmap: bigint): boolean[] {
  const bits: boolean[] = [];
  for (let i = 0; i < 3; i += 1) {
    bits.push((bitmap & (1n << BigInt(i))) !== 0n);
  }
  return bits;
}

const bridgeDebugWitnesses = {
  userPubKey(
    context: WitnessContext<BridgeDebugLedger, BridgeDebugPrivateState>,
  ): [BridgeDebugPrivateState, { bytes: Uint8Array }] {
    return [context.privateState, { bytes: new Uint8Array(32) }];
  },

  signerBitmapBits(
    context: WitnessContext<BridgeDebugLedger, BridgeDebugPrivateState>,
    bitmap: bigint,
  ): [BridgeDebugPrivateState, boolean[]] {
    const bits = computeBitmapBits(bitmap);
    return [context.privateState, bits];
  },
};

const { config: baseConfig, label: configLabel } = resolveNetworkConfig();
const INDEXER_HTTP = process.env.INDEXER_HTTP ?? baseConfig.indexer;
const INDEXER_WS = process.env.INDEXER_WS ?? baseConfig.indexerWS;
const provider = indexerPublicDataProvider(INDEXER_HTTP, INDEXER_WS);
const ZERO_COIN_PUBLIC_KEY = '0'.repeat(64);
const defaultPrivateState: BridgeDebugPrivateState = { privateState: 0 };
const GENESIS_MINT_WALLET_SEED = '0000000000000000000000000000000000000000000000000000000000000001';
const DEFAULT_VERIFIER_SECRET_KEYS = [101n, 102n, 103n] as const;
const DEFAULT_SIGNER_BITMAP = (1n << BigInt(DEFAULT_VERIFIER_SECRET_KEYS.length)) - 1n;
const SIGNATURE_NONCE = 0n;
const DEFAULT_SIGNATURE_MAX_NONCE = 256n;
const DEFAULT_SIGNATURE_THRESHOLD = 1n;
const DEFAULT_LAYER2_CHAIN_ID = 0n;
const ZERO_BYTES_32 = new Uint8Array(32);

type PublicDataProvider = ReturnType<typeof indexerPublicDataProvider>;

type NetworkPreference = 'preview' | 'undeployed';

type BridgeDebugCircuits = ImpureCircuitId<BridgeDebug.Contract<BridgeDebugPrivateState>>;
const BridgeDebugPrivateStateId = 'bridgeDebugPrivateState';

type BridgeDebugProviders = MidnightProviders<
  BridgeDebugCircuits,
  typeof BridgeDebugPrivateStateId,
  BridgeDebugPrivateState
>;

type BridgeDebugCallTx = ReturnType<typeof createCircuitCallTxInterface>;

type DeployedBridgeDebugContract = {
  contractAddress: string;
  deployTxData: {
    public: { contractAddress: string; txHash: string };
    private: { initialPrivateState: BridgeDebugPrivateState };
  };
  callTx: BridgeDebugCallTx;
};

type BridgeDebugContractHandle = {
  contractAddress: string;
  callTx: BridgeDebugCallTx;
  deployTxData?: DeployedBridgeDebugContract['deployTxData'];
};

const bridgeDebugContractInstance = new BridgeDebug.Contract<BridgeDebugPrivateState>(bridgeDebugWitnesses);

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

const resolveBridgeDebugZkConfigPath = (): string => {
  const override = process.env.BRIDGE_DEBUG_ZK_CONFIG_PATH;
  if (override) {
    return override;
  }
  return path.resolve(currentDir, '..', '..', 'bridge-contract', 'src', 'managed', 'BridgeDebug');
};

const bridgeDebugConfig = {
  privateStateStoreName: 'bridge-debug-private-state',
  zkConfigPath: resolveBridgeDebugZkConfigPath(),
};

const bridgeDebugCompiledContract = CompiledContract.make<BridgeDebug.Contract<BridgeDebugPrivateState>>(
  'BridgeDebug',
  BridgeDebug.Contract,
).pipe(
  CompiledContract.withWitnesses(bridgeDebugWitnesses),
  CompiledContract.withCompiledFileAssets(bridgeDebugConfig.zkConfigPath),
);

const deriveDefaultVerifierSet = () => DEFAULT_VERIFIER_SECRET_KEYS.map((sk) => BridgeDebug.pureCircuits.derivePk(sk));

const shouldResetVerifierSet = (): boolean => {
  const raw = (process.env.TEST_DEBUG_RESET_VERIFIER_SET ?? 'true').trim().toLowerCase();
  if (raw === 'false' || raw === '0') {
    return false;
  }
  return true;
};

async function ensureDefaultVerifierSet(bridgeContract: BridgeDebugContractHandle): Promise<void> {
  if (!shouldResetVerifierSet()) {
    console.log('Skipping verifier set reset (TEST_DEBUG_RESET_VERIFIER_SET=false).');
    return;
  }
  console.log('Ensuring verifier set matches known development keys...');
  const tx = await bridgeContract.callTx.setVerifierSet(deriveDefaultVerifierSet());
  console.log('setVerifierSet txHash:', tx.public.txHash);
}

const createProofProviderWithTimeout = (
  url: string,
  zkConfigProvider: NodeZkConfigProvider<BridgeDebugCircuits>,
  timeoutMs: number,
): ProofProvider => httpClientProofProvider(url, zkConfigProvider, { timeout: timeoutMs });

const configureBridgeDebugProviders = async (
  walletContext: api.WalletContext,
  config: Config,
): Promise<BridgeDebugProviders> => {
  setNetworkId(config.networkId);
  const walletAndMidnightProvider: WalletProvider & MidnightProvider =
    await api.createWalletAndMidnightProvider(walletContext);
  const zkConfigProvider = new NodeZkConfigProvider<BridgeDebugCircuits>(bridgeDebugConfig.zkConfigPath);
  const baseProofProvider = createProofProviderWithTimeout(config.proofServer, zkConfigProvider, config.proofTimeoutMs);
  return {
    privateStateProvider: levelPrivateStateProvider<typeof BridgeDebugPrivateStateId, BridgeDebugPrivateState>({
      privateStateStoreName: bridgeDebugConfig.privateStateStoreName,
      walletProvider: walletAndMidnightProvider,
    }),
    publicDataProvider: indexerPublicDataProvider(config.indexer, config.indexerWS),
    zkConfigProvider,
    proofProvider: baseProofProvider,
    walletProvider: walletAndMidnightProvider,
    midnightProvider: walletAndMidnightProvider,
  };
};

type BridgeDebugConstructorArgs = [
  Uint8Array,
  bigint,
  Uint8Array,
  Uint8Array,
  Uint8Array,
  { x: bigint; y: bigint }[],
  bigint,
  Uint8Array,
  Uint8Array,
];

const getOwnerBytes = (providers: BridgeDebugProviders): Uint8Array => {
  if (!providers.walletProvider) {
    throw new Error('Wallet provider is not available');
  }
  const coinPublicKey = providers.walletProvider.getCoinPublicKey();
  if (!coinPublicKey) {
    throw new Error('Wallet coin public key is not available');
  }
  return encodeCoinPublicKey(coinPublicKey);
};

const createDefaultConstructorArgs = (ownerBytes: Uint8Array): BridgeDebugConstructorArgs => {
  const verifierSet = DEFAULT_VERIFIER_SECRET_KEYS.map((sk) => BridgeDebug.pureCircuits.derivePk(sk));
  return [
    ownerBytes,
    DEFAULT_LAYER2_CHAIN_ID,
    ZERO_BYTES_32,
    ZERO_BYTES_32,
    ZERO_BYTES_32,
    verifierSet,
    DEFAULT_SIGNATURE_THRESHOLD,
    ownerBytes,
    ZERO_BYTES_32,
  ];
};

const deployBridgeDebug = async (
  providers: BridgeDebugProviders,
  privateState: BridgeDebugPrivateState,
  args?: BridgeDebugConstructorArgs,
): Promise<DeployedBridgeDebugContract> => {
  const constructorArgs = args ?? createDefaultConstructorArgs(getOwnerBytes(providers));
  if (!providers.walletProvider) {
    throw new Error('Wallet provider is not available');
  }
  if (!providers.zkConfigProvider) {
    throw new Error('ZK config provider is not available');
  }

  const verifierKeys = await providers.zkConfigProvider.getVerifierKeys(
    getImpureCircuitIds(bridgeDebugContractInstance),
  );
  if (verifierKeys.length === 0) {
    throw new Error('No verifier keys found for BridgeDebug circuits. Check zkConfigPath and artifacts.');
  }

  console.log(`Deploying BridgeDebug with all (${verifierKeys.length}) verifier keys...`);

  const signingKey = sampleSigningKey();
  const deployOptions = {
    compiledContract: bridgeDebugCompiledContract,
    privateStateId: BridgeDebugPrivateStateId,
    initialPrivateState: privateState,
    args: constructorArgs,
    signingKey,
  };

  const coinPublicKey = parseCoinPublicKeyToHex(providers.walletProvider.getCoinPublicKey(), getNetworkId());
  const unprovenDeployTxData = await createUnprovenDeployTxFromVerifierKeys(
    providers.zkConfigProvider,
    coinPublicKey,
    deployOptions,
    providers.walletProvider.getEncryptionPublicKey(),
  );

  const finalizedTxData = await submitTx(providers, {
    unprovenTx: unprovenDeployTxData.private.unprovenTx,
  });
  if (finalizedTxData.status !== SucceedEntirely) {
    throw new DeployTxFailedError(finalizedTxData);
  }

  await providers.privateStateProvider.set(
    BridgeDebugPrivateStateId,
    unprovenDeployTxData.private.initialPrivateState as BridgeDebugPrivateState,
  );
  await providers.privateStateProvider.setSigningKey(unprovenDeployTxData.public.contractAddress, signingKey);

  const contractAddress = unprovenDeployTxData.public.contractAddress;
  console.log(`BridgeDebug deployed at address: ${contractAddress}`);

  return {
    contractAddress,
    deployTxData: {
      public: {
        ...finalizedTxData,
        ...unprovenDeployTxData.public,
      },
      private: unprovenDeployTxData.private,
    },
    callTx: createCircuitCallTxInterface(
      providers,
      bridgeDebugCompiledContract,
      contractAddress,
      BridgeDebugPrivateStateId,
    ),
  };
};

const resolveBridgeDebugHandle = (
  providers: BridgeDebugProviders,
  contractAddress: string,
): BridgeDebugContractHandle => ({
  contractAddress,
  callTx: createCircuitCallTxInterface(
    providers,
    bridgeDebugCompiledContract,
    contractAddress,
    BridgeDebugPrivateStateId,
  ),
});

type SubmitBatchParams = {
  contract: BridgeDebug.Contract<BridgeDebugPrivateState>;
  contractAddress: string;
  publicDataProvider: PublicDataProvider;
  providers: BridgeDebugProviders;
  nodeUrl: string;
};

type EnsureBatchParams = SubmitBatchParams & {
  bridgeContract: BridgeDebugContractHandle;
  publicDataProvider: PublicDataProvider;
};

type BatchDataParams = {
  contract: BridgeDebug.Contract<BridgeDebugPrivateState>;
  contractAddress: string;
  contractState: ContractState;
  ledger: BridgeDebug.Ledger;
  batchHash: Uint8Array;
};

type DryRunResult = {
  ok: boolean;
  result?: unknown;
  error?: unknown;
};

const proveAndBalanceTransaction = async (
  providers: BridgeDebugProviders,
  unprovenTx: UnprovenTransaction,
): Promise<FinalizedTransaction> => {
  const unboundTx = await providers.proofProvider.proveTx(unprovenTx);
  return await providers.walletProvider.balanceTx(unboundTx);
};

const dryRunFinalizedTx = async (finalizedTx: FinalizedTransaction, nodeUrl: string): Promise<DryRunResult> => {
  const api = await ApiPromise.create({ provider: new WsProvider(nodeUrl) });
  try {
    const extrinsicHex = `0x${Buffer.from(finalizedTx.serialize()).toString('hex')}`;
    const result = await api.rpc.system.dryRun(extrinsicHex);
    console.log('Node dryRun result:', result.toString());
    return { ok: true, result };
  } catch (error) {
    console.error('Node dryRun failed:', error);
    return { ok: false, error };
  } finally {
    await api.disconnect();
  }
};

const submitFinalizeBatchWithDryRun = async (params: {
  providers: BridgeDebugProviders;
  nodeUrl: string;
  contractAddress: string;
  batchData: L1_BatchPublicDataV1Full;
  signatures: Signature[];
  signerBitmap: bigint;
  finalizeTimestamp: bigint;
}): Promise<{ txHash: string }> => {
  const callOptions = createCallTxOptions(
    bridgeDebugCompiledContract,
    'finalizeBatch',
    params.contractAddress,
    BridgeDebugPrivateStateId,
    [params.batchData, params.signatures, params.signerBitmap, params.finalizeTimestamp],
  );

  const callTxOptions: CallTxOptionsWithPrivateStateId<
    BridgeDebug.Contract<BridgeDebugPrivateState>,
    'finalizeBatch'
  > = {
    ...callOptions,
    privateStateId: BridgeDebugPrivateStateId,
  };

  const unprovenCallTxData = await createUnprovenCallTx(params.providers, callTxOptions);
  const finalizedTx = await proveAndBalanceTransaction(params.providers, unprovenCallTxData.private.unprovenTx);
  const dryRun = await dryRunFinalizedTx(finalizedTx, params.nodeUrl);
  if (!dryRun.ok) {
    throw new Error('finalizeBatch dryRun failed');
  }

  const txId = await params.providers.midnightProvider.submitTx(finalizedTx);
  const finalizedTxData = await params.providers.publicDataProvider.watchForTxData(txId);
  if (finalizedTxData.status !== SucceedEntirely) {
    throw new Error(`finalizeBatch failed with status ${String(finalizedTxData.status)}`);
  }

  if ('nextPrivateState' in unprovenCallTxData.private && unprovenCallTxData.private.nextPrivateState != null) {
    await params.providers.privateStateProvider.set(
      BridgeDebugPrivateStateId,
      unprovenCallTxData.private.nextPrivateState as BridgeDebugPrivateState,
    );
  }

  return { txHash: finalizedTxData.txHash };
};

async function submitDummyBatch(
  params: SubmitBatchParams & { bridgeContract: BridgeDebugContractHandle },
): Promise<void> {
  console.log('---');
  console.log('Preparing dummy batch to exercise commitBatch/finalizeBatch...');

  const poller = params.publicDataProvider;
  const bridgeContract = params.bridgeContract;

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
  signatures.forEach((signature, index) => {
    try {
      const valid = BridgeDebug.pureCircuits.verifyBytes32(digest, signature);
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

  try {
    const finalizeTx = await submitFinalizeBatchWithDryRun({
      providers: params.providers,
      nodeUrl: params.nodeUrl,
      contractAddress: params.contractAddress,
      batchData,
      signatures,
      signerBitmap: DEFAULT_SIGNER_BITMAP,
      finalizeTimestamp: 0n,
    });
    console.log('finalizeBatch txHash:', finalizeTx.txHash);
  } catch (finalizeError) {
    const decoded = api.decodeRpcError(finalizeError);
    console.error('finalizeBatch failed:', decoded);
    throw finalizeError;
  }

  await waitForBatchIndexUpdate(
    poller,
    params.contract,
    params.contractAddress,
    (ledger) => ledger.L1_miscData.lastFinalizedBatchIndex >= targetBatchIndex,
    'lastFinalizedBatchIndex',
  );

  const { ledger: finalLedger } = await getContractStateAndLedger(poller, params.contractAddress);
  console.log('Dummy batch finalized at index:', finalLedger.L1_miscData.lastFinalizedBatchIndex.toString());
}

async function getContractStateAndLedger(
  publicDataProvider: PublicDataProvider,
  contractAddress: string,
): Promise<{ contractState: ContractState; ledger: BridgeDebug.Ledger }> {
  const contractState = await publicDataProvider.queryContractState(contractAddress);
  if (!contractState) {
    throw new Error('No state found for contract');
  }
  return { contractState, ledger: BridgeDebug.ledger(contractState.data) };
}

async function ensurePendingBatch(
  params: EnsureBatchParams,
): Promise<{ contractState: ContractState; ledger: BridgeDebug.Ledger; batchHash: Uint8Array }> {
  const { contractState: initialContractState, ledger: initialLedger } = await getContractStateAndLedger(
    params.publicDataProvider,
    params.contractAddress,
  );
  const hasPending =
    initialLedger.L1_miscData.lastCommittedBatchIndex > initialLedger.L1_miscData.lastFinalizedBatchIndex;
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
  const ledgerWithRollingHashes = ledgerState as BridgeDebug.Ledger & {
    L1_messageRollingHashes: { member(key: bigint): boolean; lookup(key: bigint): Uint8Array };
  };
  const messageQueueHash = ledgerWithRollingHashes.L1_messageRollingHashes.member(lastProcessedQueueIndex)
    ? ledgerWithRollingHashes.L1_messageRollingHashes.lookup(lastProcessedQueueIndex)
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

function computeLastProcessedQueueIndex(ledger: BridgeDebug.Ledger): bigint {
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
  _contract: BridgeDebug.Contract<BridgeDebugPrivateState>,
  contractAddress: string,
  predicate: (ledger: BridgeDebug.Ledger) => boolean,
  label: string,
  attempts = 30,
  delayMs = 5_000,
): Promise<{ contractState: ContractState; ledger: BridgeDebug.Ledger }> {
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
  _contract: BridgeDebug.Contract<BridgeDebugPrivateState>,
  _contractAddress: string,
  contractState: ContractState,
  index: bigint,
): Promise<Uint8Array> {
  const ledger = BridgeDebug.ledger(contractState.data);
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
  const raw = (process.env.TEST_DEBUG_SIGNATURE_MAX_NONCE ?? '').trim();
  if (raw.length === 0) {
    return DEFAULT_SIGNATURE_MAX_NONCE;
  }
  const parsed = BigInt(raw);
  if (parsed <= 0n) {
    throw new Error('TEST_DEBUG_SIGNATURE_MAX_NONCE must be positive if provided');
  }
  return parsed;
}

function signWithNonceRetry(digest: Uint8Array, secretKey: bigint, signerIndex: number, limit: bigint): Signature {
  let lastError: unknown = null;
  for (let nonce = SIGNATURE_NONCE; nonce < limit; nonce += 1n) {
    try {
      const signature = BridgeDebug.pureCircuits.signBytes32(digest, secretKey, nonce) as Signature;
      const valid = BridgeDebug.pureCircuits.verifyBytes32(digest, signature) as boolean;
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

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

async function main() {
  console.log('Preparing BridgeDebug contract for finalizeBatch debugging...');
  console.log('Network preset:', configLabel);
  console.log('Indexer (HTTP/WS):', INDEXER_HTTP, INDEXER_WS);
  console.log('BridgeDebug zkConfigPath:', bridgeDebugConfig.zkConfigPath);

  const contract = bridgeDebugContractInstance;
  const logPath = path.resolve(currentDir, '..', 'logs', 'test-bridge-debug', `${new Date().toISOString()}.log`);
  const logger = await createLogger(logPath);
  api.setLogger(logger);

  let walletContext: api.WalletContext | null = null;
  try {
    walletContext = await api.buildWalletFromHexSeed(baseConfig, GENESIS_MINT_WALLET_SEED);
    const providers = await configureBridgeDebugProviders(walletContext, baseConfig);
    const poller = providers.publicDataProvider ?? provider;
    if (!poller) {
      throw new Error('Public data provider is not available');
    }

    const bridgeAddressOverride = (process.env.BRIDGE_ADDRESS ?? '').trim();
    const bridgeContract = bridgeAddressOverride
      ? resolveBridgeDebugHandle(providers, bridgeAddressOverride)
      : await deployBridgeDebug(providers, defaultPrivateState);
    const contractAddress = bridgeContract.contractAddress;
    assertIsContractAddress(contractAddress);

    if (bridgeAddressOverride) {
      console.log('Using existing BridgeDebug contract at address:', contractAddress);
    } else {
      console.log('BridgeDebug deployed at address:', contractAddress);
    }

    await ensureDefaultVerifierSet(bridgeContract);

    await submitDummyBatch({
      contract,
      contractAddress,
      publicDataProvider: poller,
      providers,
      nodeUrl: baseConfig.node,
      bridgeContract,
    });
  } finally {
    if (walletContext) {
      await api.closeWallet(walletContext);
    }
  }
}

void main().catch((error) => {
  console.error('BridgeDebug run failed:', error);
  process.exitCode = 1;
});
