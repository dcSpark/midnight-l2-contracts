import * as bip39 from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';
import { Cause } from 'effect';
import { type Logger } from 'pino';
import * as Rx from 'rxjs';
import { WebSocket } from 'ws';

import { Bridge, witnesses, type BridgePrivateState } from 'bridge-contract/browser';
import {
  BridgePrivateStateId,
  type BridgeCircuits,
  type BridgeContract,
  type BridgeProviders,
  type DeployedBridgeContract,
} from './common-types.js';
import { contractConfig, type Config } from './config.js';

import {
  createCircuitContext,
  encodeCoinPublicKey,
  sampleSigningKey,
  type ContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import * as ledger from '@midnight-ntwrk/ledger-v8';

import { CompiledContract, getProvableCircuitIds } from '@midnight-ntwrk/compact-js';
import {
  createCircuitCallTxInterface,
  createCircuitMaintenanceTxInterfaces,
  createContractMaintenanceTxInterface,
  createUnprovenDeployTxFromVerifierKeys,
  DeployTxFailedError,
  findDeployedContract,
  submitTx,
} from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { getNetworkId, setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import {
  SucceedEntirely,
  type MidnightProvider,
  type ProofProvider,
  type UnboundTransaction,
  type WalletProvider,
} from '@midnight-ntwrk/midnight-js-types';
import { assertIsContractAddress, parseCoinPublicKeyToHex } from '@midnight-ntwrk/midnight-js-utils';

import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import {
  WalletFacade,
  type DefaultConfiguration,
  type FacadeState,
  type UtxoWithMeta,
} from '@midnight-ntwrk/wallet-sdk-facade';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey as UnshieldedPublicKey,
  UnshieldedWallet,
  type UnshieldedKeystore,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { deriveDefaultVerifierSet } from './batch-helpers.js';
import { mnemonicToSeed } from './test/utils/utils.js';

let logger: Logger;

// @ts-expect-error: It's needed to enable WebSocket usage through apollo
globalThis.WebSocket = WebSocket;

export function setLogger(_logger: Logger) {
  logger = _logger;
}

type DecodedRpcError = {
  summary: string;
  customInvalidCode?: number;
  rpc?: { code?: unknown; data?: unknown; name?: string; message?: string };
  chain: string[];
  effectCause?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const messageFrom = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (isRecord(value) && typeof value.message === 'string') {
    return value.message;
  }
  return undefined;
};

const collectErrorMessages = (error: unknown, maxDepth = 6): string[] => {
  const messages: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (seen.has(current)) {
      break;
    }
    seen.add(current);
    const message = messageFrom(current);
    if (message) {
      messages.push(message);
    }
    if (!isRecord(current)) {
      break;
    }
    current = current.cause;
  }
  if (messages.length === 0) {
    const fallback = messageFrom(error) ?? String(error);
    messages.push(fallback);
  }
  return messages;
};

const findRpcLikeError = (error: unknown, maxDepth = 6): Record<string, unknown> | undefined => {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!isRecord(current) || seen.has(current)) {
      break;
    }
    seen.add(current);
    if ('code' in current || 'data' in current) {
      return current;
    }
    current = current.cause;
  }
  return undefined;
};

const findEffectCause = (error: unknown, maxDepth = 6): string | undefined => {
  if (Cause.isCause(error)) {
    return Cause.pretty(error);
  }
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!isRecord(current) || seen.has(current)) {
      break;
    }
    seen.add(current);
    const possibleCause = current.cause;
    if (Cause.isCause(possibleCause)) {
      return Cause.pretty(possibleCause);
    }
    current = possibleCause;
  }
  return undefined;
};

export const decodeRpcError = (error: unknown): DecodedRpcError => {
  const chain = collectErrorMessages(error);
  const effectCause = findEffectCause(error);
  const combined = [chain.join(' | '), effectCause].filter(Boolean).join(' | ');
  const customMatch = combined.match(/Invalid Transaction: Custom error: (\d+)/i);
  const customInvalidCode = customMatch ? Number.parseInt(customMatch[1], 10) : undefined;
  const rpcError = findRpcLikeError(error);

  const summary =
    customInvalidCode !== undefined
      ? `Invalid Transaction: Custom error: ${customInvalidCode}`
      : (chain[0] ?? 'Unknown RPC error');

  return {
    summary,
    customInvalidCode,
    rpc: rpcError
      ? {
          code: rpcError.code,
          data: rpcError.data,
          name: typeof rpcError.name === 'string' ? rpcError.name : undefined,
          message: typeof rpcError.message === 'string' ? rpcError.message : undefined,
        }
      : undefined,
    chain,
    effectCause,
  };
};

// Types for the new wallet
export interface WalletContext {
  wallet: WalletFacade;
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
}

const defaultPrivateState: BridgePrivateState = { privateState: 0 };
const DEFAULT_SIGNATURE_THRESHOLD = 1n;
const DEFAULT_LAYER2_CHAIN_ID = 0n;
const ZERO_BYTES_32 = new Uint8Array(32);

type BridgeConstructorArgs = [
  Uint8Array,
];

type BridgeInitializeArgs = [
  bigint,
  Uint8Array,
  Uint8Array,
  Uint8Array,
  { x: bigint; y: bigint }[],
  bigint,
  Uint8Array,
  Uint8Array,
];

export type BridgeConstructorArgOverrides = {
  owner?: Uint8Array;
  layer2ChainId?: bigint;
  rollupId?: Uint8Array;
  genesisStateRoot?: Uint8Array;
  genesisBatchHash?: Uint8Array;
  verifierSet?: { x: bigint; y: bigint }[];
  signatureThreshold?: bigint;
  initialSequencer?: Uint8Array;
  initialFinalizer?: Uint8Array;
};

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const createDefaultConstructorArgs = (ownerBytes: Uint8Array): BridgeConstructorArgs => {
  return [ownerBytes];
};

const createDefaultInitializeArgs = (ownerBytes: Uint8Array): BridgeInitializeArgs => {
  const verifierSet = deriveDefaultVerifierSet();
  return [
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

const applyBridgeConstructorArgOverrides = (
  defaultArgs: BridgeInitializeArgs,
  overrides?: BridgeConstructorArgOverrides,
): BridgeInitializeArgs => {
  if (!overrides) {
    return defaultArgs;
  }
  return [
    overrides.layer2ChainId ?? defaultArgs[0],
    overrides.rollupId ?? defaultArgs[1],
    overrides.genesisStateRoot ?? defaultArgs[2],
    overrides.genesisBatchHash ?? defaultArgs[3],
    overrides.verifierSet ?? defaultArgs[4],
    overrides.signatureThreshold ?? defaultArgs[5],
    overrides.initialSequencer ?? defaultArgs[6],
    overrides.initialFinalizer ?? defaultArgs[7],
  ];
};

export const resolveBridgeConstructorArgs = (
  providers: BridgeProviders,
  overrides?: BridgeConstructorArgOverrides,
): BridgeConstructorArgs => [overrides?.owner ?? getOwnerBytes(providers)];

export const resolveBridgeInitializeArgs = (
  providers: BridgeProviders,
  overrides?: BridgeConstructorArgOverrides,
): BridgeInitializeArgs =>
  applyBridgeConstructorArgOverrides(createDefaultInitializeArgs(getOwnerBytes(providers)), overrides);

/**
 * Sign all unshielded offers in a transaction's intents, using the correct
 * proof marker for Intent.deserialize. This works around a bug in the wallet
 * SDK where signRecipe hardcodes 'pre-proof', which fails for proven
 * (UnboundTransaction) intents that contain 'proof' data.
 */
/**
 * Sign all unshielded offers in a transaction's intents.
 *
 * Only intents that contain unshielded offers with inputs are deserialized,
 * signed, and written back. Intents without offers are left untouched to
 * avoid corrupting their data via the deserialize round-trip.
 *
 * The intents collection is an immutable WASM-backed Map: `.set()` returns a
 * new collection that must be assigned back to `tx.intents` (like the wallet
 * SDK does in TransactionOps.addSignature).
 */
const signTransactionIntents = (
  tx: { intents?: Map<number, { serialize: () => Uint8Array }> },
  signFn: (payload: Uint8Array) => ledger.Signature,
  proofMarker: 'proof' | 'pre-proof',
): void => {
  if (!tx.intents || tx.intents.size === 0) return;

  for (const segment of tx.intents.keys()) {
    const intent = tx.intents.get(segment);
    if (!intent) continue;

    const cloned = ledger.Intent.deserialize<ledger.SignatureEnabled, ledger.Proofish, ledger.PreBinding>(
      'signature',
      proofMarker,
      'pre-binding',
      intent.serialize(),
    );

    const hasFallible =
      cloned.fallibleUnshieldedOffer != null && cloned.fallibleUnshieldedOffer.inputs.length > 0;
    const hasGuaranteed =
      cloned.guaranteedUnshieldedOffer != null && cloned.guaranteedUnshieldedOffer.inputs.length > 0;

    // Skip intents without unshielded offers — deserialize round-trip can corrupt them
    if (!hasFallible && !hasGuaranteed) continue;

    const sigData = cloned.signatureData(segment);
    const signature = signFn(sigData);

    if (hasFallible) {
      const offer = cloned.fallibleUnshieldedOffer!;
      const sigs = offer.inputs.map(
        (_: ledger.UtxoSpend, i: number) => offer.signatures.at(i) ?? signature,
      );
      cloned.fallibleUnshieldedOffer = offer.addSignatures(sigs);
    }

    if (hasGuaranteed) {
      const offer = cloned.guaranteedUnshieldedOffer!;
      const sigs = offer.inputs.map(
        (_: ledger.UtxoSpend, i: number) => offer.signatures.at(i) ?? signature,
      );
      cloned.guaranteedUnshieldedOffer = offer.addSignatures(sigs);
    }

    // Immutable WASM map: .set() returns a new collection — must reassign
    tx.intents = tx.intents.set(segment, cloned) as Map<number, { serialize: () => Uint8Array }>;
  }
};

export type BridgeL1ToL2DepositMessage = {
  readonly sender: Uint8Array;
  readonly recipient: Uint8Array;
  readonly amount: bigint;
  readonly nonce: bigint;
  readonly gasLimit: bigint;
  readonly dataHash: Uint8Array;
};

const ZERO_COIN_PUBLIC_KEY = '0'.repeat(64);

const getOwnerBytes = (providers: BridgeProviders): Uint8Array => {
  if (!providers.walletProvider) {
    throw new Error('Wallet provider is not available');
  }
  const coinPublicKey = providers.walletProvider.getCoinPublicKey();
  if (!coinPublicKey) {
    throw new Error('Wallet coin public key is not available');
  }
  return encodeCoinPublicKey(coinPublicKey);
};

/** Build a circuit context from indexer contract state for off-chain getter reads (queryContractState + circuits). */
const getBridgeStateContext = async (
  providers: BridgeProviders,
  contractAddress: ContractAddress,
): Promise<{ context: ReturnType<typeof createCircuitContext>; contract: BridgeContract } | null> => {
  assertIsContractAddress(contractAddress);
  if (!providers.publicDataProvider) {
    return null;
  }
  const contractState = await providers.publicDataProvider.queryContractState(contractAddress);
  if (contractState == null) {
    return null;
  }
  const context = createCircuitContext<BridgePrivateState>(
    contractAddress,
    ZERO_COIN_PUBLIC_KEY,
    contractState,
    defaultPrivateState,
  );
  return { context, contract: bridgeContractInstance };
};

const ZERO_BYTES_32_BRIDGE = new Uint8Array(32);

/** Recommended: get Ledger from indexer state (queryContractState + Bridge.ledger). Returns null if no state. */
export const getBridgeLedger = async (
  providers: BridgeProviders,
  contractAddress: ContractAddress,
): Promise<ReturnType<typeof Bridge.ledger> | null> => {
  assertIsContractAddress(contractAddress);
  if (!providers.publicDataProvider) {
    return null;
  }
  const contractState = await providers.publicDataProvider.queryContractState(contractAddress);
  if (contractState == null) {
    return null;
  }
  return Bridge.ledger(contractState.data);
};

export const getMessageRollingHash = async (
  providers: BridgeProviders,
  contractAddress: ContractAddress,
  index: bigint,
): Promise<Uint8Array | null> => {
  const ledgerState = await getBridgeLedger(providers, contractAddress);
  if (ledgerState == null || !ledgerState.L1_messageRollingHashes.member(index)) {
    return null;
  }
  return ledgerState.L1_messageRollingHashes.lookup(index);
};

export const getMessageTimestamp = async (
  providers: BridgeProviders,
  contractAddress: ContractAddress,
  index: bigint,
): Promise<bigint | null> => {
  const stateContext = await getBridgeStateContext(providers, contractAddress);
  if (!stateContext) {
    return null;
  }
  const circuits = stateContext.contract.circuits as Record<
    string,
    (ctx: unknown, ...args: unknown[]) => { result: unknown; context: unknown }
  >;
  const r = circuits.getMessageTimestamp(stateContext.context, index);
  return (r.result as bigint) ?? null;
};

export const getL1ToL2Deposit = async (
  providers: BridgeProviders,
  contractAddress: ContractAddress,
  queueIndex: bigint,
): Promise<BridgeL1ToL2DepositMessage | null> => {
  const ledgerState = await getBridgeLedger(providers, contractAddress);
  if (ledgerState != null && 'L1_l1ToL2Deposits' in ledgerState) {
    const deposits = (ledgerState as { L1_l1ToL2Deposits: { member(k: bigint): boolean; lookup(k: bigint): BridgeL1ToL2DepositMessage } })
      .L1_l1ToL2Deposits;
    if (deposits.member(queueIndex)) {
      return deposits.lookup(queueIndex);
    }
  }
  const stateContext = await getBridgeStateContext(providers, contractAddress);
  if (!stateContext) {
    return null;
  }
  const circuits = stateContext.contract.circuits as Record<
    string,
    (ctx: unknown, ...args: unknown[]) => { result: unknown; context: unknown }
  >;
  const r = circuits.getL1ToL2Deposit?.(stateContext.context, queueIndex);
  return (r?.result as BridgeL1ToL2DepositMessage) ?? null;
};

export const bridgeContractInstance: BridgeContract = new Bridge.Contract(witnesses);
export const bridgeCompiledContract = CompiledContract.make<BridgeContract>('Bridge', Bridge.Contract).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets(contractConfig.zkConfigPath),
);

export const joinContract = async (
  providers: BridgeProviders,
  contractAddress: string,
): Promise<DeployedBridgeContract> => {
  logger.info(`Finding deployed contract: ${contractAddress}`);
  assertIsContractAddress(contractAddress);
  const bridgeContract = await findDeployedContract(providers, {
    contractAddress,
    compiledContract: bridgeCompiledContract,
    privateStateId: BridgePrivateStateId,
    initialPrivateState: defaultPrivateState,
  });
  logger.info(`Joined contract at address: ${bridgeContract.deployTxData.public.contractAddress}`);
  return bridgeContract;
};

export const deploy = async (
  providers: BridgeProviders,
  privateState: BridgePrivateState,
  args?: BridgeConstructorArgs,
): Promise<DeployedBridgeContract> => {
  const constructorArgs = args ?? resolveBridgeConstructorArgs(providers);
  if (!providers.walletProvider) {
    throw new Error('Wallet provider is not available');
  }
  if (!providers.zkConfigProvider) {
    throw new Error('ZK config provider is not available');
  }

  const verifierKeys = await providers.zkConfigProvider.getVerifierKeys(getProvableCircuitIds(bridgeContractInstance));
  if (verifierKeys.length === 0) {
    throw new Error('No verifier keys found for bridge circuits. Check zkConfigPath and artifacts.');
  }

  logger.info(`Deploying bridge contract with all (${verifierKeys.length}) verifier keys...`);

  const signingKey = sampleSigningKey();
  const deployOptions = {
    compiledContract: bridgeCompiledContract,
    privateStateId: BridgePrivateStateId,
    initialPrivateState: privateState,
    args: constructorArgs,
    signingKey,
  };
  const coinPublicKey = parseCoinPublicKeyToHex(providers.walletProvider.getCoinPublicKey(), getNetworkId());
  const unprovenDeployTxData = (await createUnprovenDeployTxFromVerifierKeys(
    providers.zkConfigProvider,
    coinPublicKey,
    deployOptions as never,
    providers.walletProvider.getEncryptionPublicKey(),
  )) as any;
  const finalizedTxData = await submitTx(providers, {
    unprovenTx: unprovenDeployTxData.private.unprovenTx,
  });
  if (finalizedTxData.status !== SucceedEntirely) {
    throw new DeployTxFailedError(finalizedTxData);
  }

  providers.privateStateProvider.setContractAddress(unprovenDeployTxData.public.contractAddress);
  await providers.privateStateProvider.set(BridgePrivateStateId, unprovenDeployTxData.private.initialPrivateState);
  await providers.privateStateProvider.setSigningKey(unprovenDeployTxData.public.contractAddress, signingKey);

  const contractAddress = unprovenDeployTxData.public.contractAddress;
  logger.info(`Deployed contract at address: ${contractAddress}`);

  const deployTxData = {
    public: {
      ...finalizedTxData,
      ...unprovenDeployTxData.public,
    },
    private: unprovenDeployTxData.private,
  };

  return {
    deployTxData,
    callTx: createCircuitCallTxInterface(providers, bridgeCompiledContract, contractAddress, BridgePrivateStateId),
    circuitMaintenanceTx: createCircuitMaintenanceTxInterfaces(providers, bridgeCompiledContract, contractAddress),
    contractMaintenanceTx: createContractMaintenanceTxInterface(providers, bridgeCompiledContract, contractAddress),
  } as DeployedBridgeContract;
};

export const displayBridgeState = async (
  providers: BridgeProviders,
  bridgeContract: DeployedBridgeContract,
): Promise<{ ledger: ReturnType<typeof Bridge.ledger> | null; contractAddress: string }> => {
  const contractAddress = bridgeContract.deployTxData.public.contractAddress;
  const ledger = await getBridgeLedger(providers, contractAddress);
  if (ledger === null) {
    logger.info(`There is no contract deployed at ${contractAddress}.`);
  } else {
    const lastFinalized = ledger.L1_miscData.lastFinalizedBatchIndex;
    const withdrawRoot = ledger.L1_withdrawRoots.member(lastFinalized)
      ? ledger.L1_withdrawRoots.lookup(lastFinalized)
      : ZERO_BYTES_32_BRIDGE;
    const withdrawMessageCount = ledger.L1_executedL2ToL1Messages.size();
    logger.info({
      section: 'Bridge State',
      nextCrossDomainMessageIndex: ledger.L1_nextCrossDomainMessageIndex,
      nextUnfinalizedQueueIndex: ledger.L1_nextUnfinalizedQueueIndex,
      lockedNIGHT: ledger.L1_lockedNIGHT,
      feeVault: ledger.L1_feeVault,
      withdrawMessageCount,
      withdrawRoot: toHex(withdrawRoot),
    });
  }
  return { contractAddress, ledger };
};

export const createWalletAndMidnightProvider = async (
  walletContext: WalletContext,
): Promise<WalletProvider & MidnightProvider> => {
  const state = await Rx.firstValueFrom(walletContext.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  logger.debug({
    section: 'DUST Wallet State',
    dust: state.dust,
  });
  logger.debug({
    section: 'Shielded Wallet State',
    shielded: state.shielded,
  });
  logger.debug({
    section: 'Unshielded Wallet State',
    unshielded: state.unshielded,
  });
  return {
    getCoinPublicKey(): ledger.CoinPublicKey {
      return walletContext.shieldedSecretKeys.coinPublicKey as unknown as ledger.CoinPublicKey;
    },
    getEncryptionPublicKey(): ledger.EncPublicKey {
      return walletContext.shieldedSecretKeys.encryptionPublicKey as unknown as ledger.EncPublicKey;
    },
    async balanceTx(tx: UnboundTransaction, ttl?: Date): Promise<ledger.FinalizedTransaction> {
      const txTtl = ttl ?? new Date(Date.now() + 30 * 60 * 1000); // 30 min default TTL
      const recipe = await walletContext.wallet.balanceUnboundTransaction(
        tx,
        {
          shieldedSecretKeys: walletContext.shieldedSecretKeys,
          dustSecretKey: walletContext.dustSecretKey,
        },
        { ttl: txTtl },
      );

      // Work around wallet SDK bug: signRecipe uses hardcoded 'pre-proof' marker when
      // cloning intents, but proven (UnboundTransaction) intents have 'proof' data,
      // causing "Failed to clone intent". Sign manually with the correct proof markers.
      const signFn = (payload: Uint8Array) => walletContext.unshieldedKeystore.signData(payload);
      signTransactionIntents(recipe.baseTransaction, signFn, 'proof');
      if (recipe.balancingTransaction) {
        signTransactionIntents(recipe.balancingTransaction, signFn, 'pre-proof');
      }

      return await walletContext.wallet.finalizeRecipe(recipe);
    },
    async submitTx(tx: ledger.FinalizedTransaction): Promise<ledger.TransactionId> {
      try {
        return await walletContext.wallet.submitTransaction(tx);
      } catch (error) {
        logger.error({ decoded: decodeRpcError(error) }, 'submitTx failed');
        throw error;
      }
    },
  };
};

/** Default timeout for wallet sync (e.g. node unreachable). */
const WALLET_SYNC_TIMEOUT_MS = 60_000;

export const waitForSync = (wallet: WalletFacade) =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(5_000),
      Rx.tap((state) => {
        logger.info(`Waiting for wallet sync. Synced: ${state.isSynced}`);
      }),
      Rx.filter((state) => state.isSynced),
      Rx.timeout({ first: WALLET_SYNC_TIMEOUT_MS }),
    ),
  ).catch((err: unknown) => {
    const isTimeout =
      (err && typeof err === 'object' && 'name' in err && (err as { name?: string }).name === 'TimeoutError') ||
      (err instanceof Error && err.message.includes('Timeout'));
    if (isTimeout) {
      throw new Error(
        `Wallet did not sync within ${WALLET_SYNC_TIMEOUT_MS / 1000}s. Is the Midnight node running? (MIDNIGHT_NODE_WS, default ws://127.0.0.1:9944)`,
      );
    }
    throw err;
  });

export const waitForFunds = (wallet: WalletFacade) =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(10_000),
      Rx.tap((state) => {
        const unshielded = state.unshielded?.balances[ledger.unshieldedToken().raw] ?? 0n;
        const shielded = state.shielded?.balances[ledger.unshieldedToken().raw] ?? 0n;
        logger.info(`Waiting for funds. Synced: ${state.isSynced}, Unshielded: ${unshielded}, Shielded: ${shielded}`);
      }),
      Rx.filter((state) => state.isSynced),
      Rx.map(
        (s) =>
          (s.unshielded?.balances[ledger.unshieldedToken().raw] ?? 0n) +
          (s.shielded?.balances[ledger.unshieldedToken().raw] ?? 0n),
      ),
      Rx.filter((balance) => balance > 0n),
    ),
  );

/**
 * Display wallet balances (unshielded, shielded, total)
 */
export const displayWalletBalances = async (
  wallet: WalletFacade,
): Promise<{ unshielded: any; shielded: bigint; total: bigint }> => {
  const state = await Rx.firstValueFrom(wallet.state());
  const unshielded = state.unshielded?.balances[ledger.unshieldedToken().raw] ?? 0n;
  const shielded = state.shielded?.balances[ledger.unshieldedToken().raw] ?? 0n;
  const total = unshielded + shielded;

  logger.info(`Unshielded balance: ${unshielded} tSTAR`);
  logger.info(`Shielded balance: ${shielded} tSTAR`);
  logger.info(`Total balance: ${total} tSTAR`);

  return { unshielded, shielded, total };
};

/**
 * Register unshielded Night UTXOs for dust generation
 * This is required before the wallet can pay transaction fees
 */
export const registerNightForDust = async (walletContext: WalletContext): Promise<boolean> => {
  const state = await Rx.firstValueFrom(walletContext.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  const dustBalance = state.dust?.balance(new Date()) ?? 0n;

  // Check if we have unshielded coins that are not registered for dust generation
  const unregisteredNightUtxos =
    state.unshielded?.availableCoins.filter((coin) => !isRegisteredForDustGeneration(coin)) ?? [];

  if (unregisteredNightUtxos.length === 0) {
    logger.info('No unshielded Night UTXOs available for dust registration, or all are already registered');

    // Check current dust balance
    logger.info(`Current dust balance: ${dustBalance}`);

    return dustBalance > 0n;
  }

  const maxUtxosEnv = process.env.DUST_REGISTRATION_MAX_UTXOS;
  const maxUtxosToRegister =
    maxUtxosEnv && Number.isFinite(Number.parseInt(maxUtxosEnv, 10))
      ? Math.max(0, Number.parseInt(maxUtxosEnv, 10))
      : null;

  const sortedUtxos = [...unregisteredNightUtxos].sort((a, b) => {
    if (a.utxo.value < b.utxo.value) return -1;
    if (a.utxo.value > b.utxo.value) return 1;
    return 0;
  });

  const utxosToRegister = maxUtxosToRegister === null ? sortedUtxos : sortedUtxos.slice(0, maxUtxosToRegister);

  if (maxUtxosToRegister !== null && maxUtxosToRegister < unregisteredNightUtxos.length) {
    logger.info(
      `Limiting dust registration to ${utxosToRegister.length} UTXO(s); ${unregisteredNightUtxos.length - utxosToRegister.length} will remain spendable`,
    );
  }

  if (utxosToRegister.length === 0) {
    logger.info('Skipping dust registration (DUST_REGISTRATION_MAX_UTXOS=0)');
    logger.info(`Current dust balance: ${dustBalance}`);
    return dustBalance > 0n;
  }

  logger.info(`Found ${unregisteredNightUtxos.length} unshielded Night UTXOs not registered for dust generation`);
  logger.info('Registering Night UTXOs for dust generation...');

  try {
    const recipe = await walletContext.wallet.registerNightUtxosForDustGeneration(
      utxosToRegister,
      walletContext.unshieldedKeystore.getPublicKey(),
      (payload) => walletContext.unshieldedKeystore.signData(payload),
    );

    logger.info('Finalizing dust registration transaction...');
    const finalizedTx = await walletContext.wallet.finalizeRecipe(recipe);

    logger.info('Submitting dust registration transaction...');
    const txId = await walletContext.wallet.submitTransaction(finalizedTx);
    logger.info(`Dust registration submitted with tx id: ${txId}`);

    // Wait for dust to be available
    logger.info('Waiting for dust to be generated...');
    await Rx.firstValueFrom(
      walletContext.wallet.state().pipe(
        Rx.throttleTime(5_000),
        Rx.tap((s) => {
          const dustBalance = s.dust?.balance(new Date()) ?? 0n;
          logger.info(`Dust balance: ${dustBalance}`);
        }),
        Rx.filter((s) => (s.dust?.balance(new Date()) ?? 0n) > 0n),
      ),
    );

    logger.info('Dust registration complete!');
    return true;
  } catch (e) {
    logger.error(`Failed to register Night UTXOs for dust: ${e}`);
    return false;
  }
};

export interface EnsureSpendableUnshieldedNightOptions {
  keepRegisteredUtxos?: number;
  minSpendableBalance?: bigint;
  minDustBalance?: bigint;
  waitForDustMs?: number;
}

const sumUtxoValues = (utxos: readonly UtxoWithMeta[]): bigint =>
  utxos.reduce((sum, coin) => sum + coin.utxo.value, 0n);

const isRegisteredForDustGeneration = (coin: UtxoWithMeta): boolean => {
  const meta = coin.meta as UtxoWithMeta['meta'] & { registeredForDustGeneration?: boolean };
  return meta.registeredForDustGeneration === true;
};

const sortUtxosByValueAsc = (utxos: readonly UtxoWithMeta[]): UtxoWithMeta[] =>
  [...utxos].sort((a, b) => {
    if (a.utxo.value < b.utxo.value) return -1;
    if (a.utxo.value > b.utxo.value) return 1;
    return 0;
  });

const getNightUtxos = (state: FacadeState): UtxoWithMeta[] =>
  (state.unshielded?.availableCoins ?? []).filter((coin) => coin.utxo.type === ledger.unshieldedToken().raw);

const getSpendableNightUtxos = (state: FacadeState): UtxoWithMeta[] =>
  getNightUtxos(state).filter((coin) => !isRegisteredForDustGeneration(coin));

const getRegisteredNightUtxos = (state: FacadeState): UtxoWithMeta[] =>
  getNightUtxos(state).filter((coin) => isRegisteredForDustGeneration(coin));

const waitForDustBalance = async (
  walletContext: WalletContext,
  minBalance: bigint,
  timeoutMs: number,
): Promise<bigint> =>
  await Rx.firstValueFrom(
    walletContext.wallet.state().pipe(
      Rx.filter((state) => state.isSynced),
      Rx.map((state) => state.dust?.balance(new Date()) ?? 0n),
      Rx.filter((balance) => balance >= minBalance),
      Rx.timeout({ first: timeoutMs }),
    ),
  );

const waitForSpendableBalance = async (
  walletContext: WalletContext,
  minBalance: bigint,
  timeoutMs: number,
): Promise<bigint> =>
  await Rx.firstValueFrom(
    walletContext.wallet.state().pipe(
      Rx.filter((state) => state.isSynced),
      Rx.map((state) => sumUtxoValues(getSpendableNightUtxos(state))),
      Rx.filter((balance) => balance >= minBalance),
      Rx.timeout({ first: timeoutMs }),
    ),
  );

export const ensureSpendableUnshieldedNight = async (
  walletContext: WalletContext,
  options: EnsureSpendableUnshieldedNightOptions = {},
): Promise<{
  spendableBalance: bigint;
  dustBalance: bigint;
  registeredCount: number;
  unregisteredCount: number;
}> => {
  const keepRegisteredUtxos = Math.max(0, options.keepRegisteredUtxos ?? 1);
  const minSpendableBalance = options.minSpendableBalance ?? 1n;
  const minDustBalance = options.minDustBalance ?? 1n;
  const waitForDustMs = options.waitForDustMs ?? 120_000;

  const syncedState = (): Promise<FacadeState> =>
    Rx.firstValueFrom(walletContext.wallet.state().pipe(Rx.filter((s) => s.isSynced)));

  let state = await syncedState();

  const nightUtxos = getNightUtxos(state);
  if (nightUtxos.length === 0) {
    throw new Error('No unshielded NIGHT UTXOs available');
  }

  let spendableUtxos = getSpendableNightUtxos(state);
  let registeredUtxos = getRegisteredNightUtxos(state);
  let spendableBalance = sumUtxoValues(spendableUtxos);
  let dustBalance = state.dust?.balance(new Date()) ?? 0n;

  if (dustBalance < minDustBalance) {
    if (registeredUtxos.length === 0) {
      const toRegister = sortUtxosByValueAsc(spendableUtxos).slice(0, Math.max(1, keepRegisteredUtxos));
      if (toRegister.length === 0) {
        throw new Error('No unshielded NIGHT UTXOs available to register for dust generation');
      }
      logger.info(`Registering ${toRegister.length} unshielded NIGHT UTXO(s) for dust generation...`);
      const recipe = await walletContext.wallet.registerNightUtxosForDustGeneration(
        toRegister,
        walletContext.unshieldedKeystore.getPublicKey(),
        (payload) => walletContext.unshieldedKeystore.signData(payload),
      );
      const finalizedTx = await walletContext.wallet.finalizeRecipe(recipe);
      const txId = await walletContext.wallet.submitTransaction(finalizedTx);
      logger.info(`Dust registration submitted with tx id: ${txId}`);
    }

    dustBalance = await waitForDustBalance(walletContext, minDustBalance, waitForDustMs);
  }

  state = await syncedState();
  registeredUtxos = getRegisteredNightUtxos(state);

  if (registeredUtxos.length > keepRegisteredUtxos) {
    const sortedRegistered = sortUtxosByValueAsc(registeredUtxos);
    const toDeregister = sortedRegistered.slice(keepRegisteredUtxos);
    logger.info(`Deregistering ${toDeregister.length} unshielded NIGHT UTXO(s) from dust generation...`);
    const recipe = await walletContext.wallet.deregisterFromDustGeneration(
      toDeregister,
      walletContext.unshieldedKeystore.getPublicKey(),
      (payload) => walletContext.unshieldedKeystore.signData(payload),
    );
    const finalizedTx = await walletContext.wallet.finalizeRecipe(recipe);
    const txId = await walletContext.wallet.submitTransaction(finalizedTx);
    logger.info(`Dust deregistration submitted with tx id: ${txId}`);
  }

  spendableBalance = await waitForSpendableBalance(walletContext, minSpendableBalance, waitForDustMs);

  state = await syncedState();
  spendableUtxos = getSpendableNightUtxos(state);
  registeredUtxos = getRegisteredNightUtxos(state);
  dustBalance = state.dust?.balance(new Date()) ?? 0n;

  return {
    spendableBalance,
    dustBalance,
    registeredCount: registeredUtxos.length,
    unregisteredCount: spendableUtxos.length,
  };
};

/**
 * Initialize wallet with seed using the new wallet SDK
 */
export const initWalletWithSeed = async (seed: Buffer, config: Config): Promise<WalletContext> => {
  const hdWallet = HDWallet.fromSeed(seed);

  if (hdWallet.type !== 'seedOk') {
    throw new Error('Failed to initialize HDWallet');
  }

  const derivationResult = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);

  if (derivationResult.type !== 'keysDerived') {
    throw new Error('Failed to derive keys');
  }

  hdWallet.hdWallet.clear();

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(derivationResult.keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(derivationResult.keys[Roles.Dust]);

  const unshieldedKeystore = createKeystore(derivationResult.keys[Roles.NightExternal], config.networkId);

  type ShieldedConfig = Parameters<typeof ShieldedWallet>[0];
  type DustConfig = Parameters<typeof DustWallet>[0];
  type UnshieldedConfig = Parameters<typeof UnshieldedWallet>[0];
  const baseConfig = {
    networkId: config.networkId,
    costParameters: {
      additionalFeeOverhead: 300_000_000_000_000n, // 300 trillion - matches SDK examples
      feeBlocksMargin: 5,
    },
    relayURL: new URL(config.node),
    provingServerUrl: new URL(config.proofServer),
    indexerClientConnection: {
      indexerHttpUrl: config.indexer,
      indexerWsUrl: config.indexerWS,
    },
    indexerUrl: config.indexerWS,
  };

  const facade = await WalletFacade.init({
    configuration: baseConfig as unknown as DefaultConfiguration,
    shielded: (cfg) => ShieldedWallet(cfg as ShieldedConfig).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (cfg) =>
      UnshieldedWallet({
        ...(cfg as UnshieldedConfig),
        txHistoryStorage: new InMemoryTransactionHistoryStorage(),
      } as UnshieldedConfig).startWithPublicKey(UnshieldedPublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (cfg) =>
      DustWallet(cfg as DustConfig).startWithSecretKey(
        dustSecretKey,
        ledger.LedgerParameters.initialParameters().dust,
      ),
  });
  await facade.start(shieldedSecretKeys, dustSecretKey);

  return { wallet: facade, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
};

/**
 * Build wallet from mnemonic and wait for funds
 */
export const buildWalletAndWaitForFunds = async (config: Config, mnemonic: string): Promise<WalletContext> => {
  logger.info(`Building wallet from mnemonic... ${mnemonic}`);

  const seed = await mnemonicToSeed(mnemonic);
  const walletContext = await initWalletWithSeed(seed, config);

  logger.info(`!Your wallet address: ${walletContext.unshieldedKeystore.getBech32Address().asString()}`);

  // Wait for sync first
  logger.info('Waiting for wallet to sync...');
  await waitForSync(walletContext.wallet);

  // Display and check balance
  const { total } = await displayWalletBalances(walletContext.wallet);

  if (total === 0n) {
    logger.info('Waiting to receive tokens...');
    await waitForFunds(walletContext.wallet);
    await displayWalletBalances(walletContext.wallet);
  }

  // Register Night UTXOs for dust generation (required for paying fees)
  await registerNightForDust(walletContext);

  return walletContext;
};

/**
 * Generate a fresh wallet with random mnemonic
 */
export const buildFreshWallet = async (config: Config): Promise<WalletContext> => {
  const mnemonic = bip39.generateMnemonic(english, 256);
  logger.info(`Generated new wallet mnemonic: ${mnemonic}`);
  return await buildWalletAndWaitForFunds(config, mnemonic);
};

/**
 * Build wallet from hex seed (for backwards compatibility with genesis wallet)
 */
export const buildWalletFromHexSeed = async (config: Config, hexSeed: string): Promise<WalletContext> => {
  logger.info('Building wallet from hex seed...');
  const seed = Buffer.from(hexSeed, 'hex');
  const walletContext = await initWalletWithSeed(seed, config);

  logger.info(`Your wallet address: ${walletContext.unshieldedKeystore.getBech32Address().asString()}`);

  // Wait for sync first
  logger.info('Waiting for wallet to sync...');
  await waitForSync(walletContext.wallet);

  // Display and check balance
  const { total } = await displayWalletBalances(walletContext.wallet);

  if (total === 0n) {
    logger.info('Waiting to receive tokens...');
    await waitForFunds(walletContext.wallet);
    await displayWalletBalances(walletContext.wallet);
  }

  // Register Night UTXOs for dust generation (required for paying fees)
  await registerNightForDust(walletContext);

  return walletContext;
};

const createProofProviderWithTimeout = (
  url: string,
  zkConfigProvider: NodeZkConfigProvider<BridgeCircuits>,
  timeoutMs: number,
): ProofProvider => httpClientProofProvider(url, zkConfigProvider, { timeout: timeoutMs });

export const configureProviders = async (walletContext: WalletContext, config: Config): Promise<BridgeProviders> => {
  // Set global network ID - required before contract deployment
  setNetworkId(config.networkId);

  const walletAndMidnightProvider = await createWalletAndMidnightProvider(walletContext);
  const zkConfigProvider = new NodeZkConfigProvider<BridgeCircuits>(contractConfig.zkConfigPath);
  const baseProofProvider = createProofProviderWithTimeout(config.proofServer, zkConfigProvider, config.proofTimeoutMs);
  const accountId = walletContext.unshieldedKeystore.getBech32Address().asString();
  return {
    privateStateProvider: levelPrivateStateProvider<typeof BridgePrivateStateId, BridgePrivateState>({
      privateStateStoreName: contractConfig.privateStateStoreName,
      privateStoragePasswordProvider: contractConfig.privateStoragePasswordProvider,
      accountId,
    }),
    publicDataProvider: indexerPublicDataProvider(config.indexer, config.indexerWS),
    zkConfigProvider,
    proofProvider: baseProofProvider,
    walletProvider: walletAndMidnightProvider,
    midnightProvider: walletAndMidnightProvider,
  };
};

export const closeWallet = async (walletContext: WalletContext): Promise<void> => {
  try {
    await walletContext.wallet.stop();
  } catch (e) {
    logger.error(`Error closing wallet: ${e}`);
  }
};
