/**
 * finalize-batch command: finalize a batch by passing the exact four contract arguments.
 * finalizeBatch(batchPublicData_, signatures_, signerBitmap_, finalizeTimestamp_)
 * First two args are complex types and are passed as JSON strings from the CLI.
 */
import * as api from '../api.js';
import {
  buildBatchPublicData,
  buildSignatureVector,
  ensurePendingBatch,
  hashBatchPublicDataV1Full,
  warnIfBatchDigestArtifactMismatch,
  DEFAULT_SIGNER_BITMAP,
  type L1_BatchPublicDataV1Full,
  type Signature,
  type BridgeLedger,
  type EnsureBatchParams,
  type BatchDataParams,
} from '../batch-helpers.js';
import type { ContractState } from '@midnight-ntwrk/compact-runtime';
import type { DeployedBridgeContract } from '../common-types.js';
import { type CliConfig, getWalletSeedFromEnv } from '../cli-config.js';
import { Bridge, type BridgePrivateState, witnesses } from 'bridge-contract/browser';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { createLogger } from '../logger.js';
import path from 'node:path';
import { currentDir } from '../config.js';
import type { ExecutorContext } from '../executor-context.js';

/** Options for runFinalizeBatch: the four required arguments to finalizeBatch. */
export interface FinalizeBatchOptions {
  batchPublicData: L1_BatchPublicDataV1Full;
  signatures: Signature[];
  signerBitmap: bigint;
  finalizeTimestamp: bigint;
  json?: boolean;
}

export interface FinalizeBatchResult {
  txHash: string;
  batchIndex: string;
  status: string;
}

export interface FinalizeBatchFromLedgerResult {
  txHash: string;
  batchIndex: string;
  status: string;
}

/**
 * Build the four finalizeBatch arguments from current ledger state (wallet, joinContract,
 * ensurePendingBatch, buildBatchPublicData, buildSignatureVector).
 * Used by test-decode or callers that only need the args (e.g. to print or pass to another process).
 * Closes the wallet when done; use runFinalizeBatchFromLedger to get args and submit in one session.
 */
export async function getFinalizeBatchArgsFromLedger(
  cliConfig: CliConfig,
): Promise<{
  batchPublicData: L1_BatchPublicDataV1Full;
  signatures: Signature[];
  signerBitmap: bigint;
  finalizeTimestamp: bigint;
}> {
  const result = await withLedgerAndBridgeContract(cliConfig, undefined, async (ctx) => {
    const { contractState, ledger, batchHash } = ctx;
    const targetBatchIndex = ledger.L1_miscData.lastFinalizedBatchIndex + 1n;
    if (ledger.L1_miscData.lastCommittedBatchIndex < targetBatchIndex) {
      throw new Error('No committed batch available to finalize.');
    }
    const batchDataParams: BatchDataParams = {
      contract: ctx.contract,
      contractAddress: ctx.contractAddress,
      contractState,
      ledger,
      batchHash,
    };
    const batchPublicData = await buildBatchPublicData(batchDataParams);
    const digest = hashBatchPublicDataV1Full(batchPublicData);
    warnIfBatchDigestArtifactMismatch(batchPublicData, digest);
    const signatures = buildSignatureVector(digest);
    return {
      batchPublicData,
      signatures,
      signerBitmap: DEFAULT_SIGNER_BITMAP,
      finalizeTimestamp: 0n,
    };
  });
  return result;
}

/**
 * Run finalize-batch-from-ledger in a single wallet session: build args from ledger then submit.
 * Avoids building wallet and joining contract twice.
 */
export async function runFinalizeBatchFromLedger(
  cliConfig: CliConfig,
  opts: { json?: boolean },
  executorContext?: ExecutorContext,
): Promise<FinalizeBatchFromLedgerResult> {
  return withLedgerAndBridgeContract(cliConfig, executorContext, async (ctx) => {
    const { contractState, ledger, batchHash, bridgeContract } = ctx;
    const targetBatchIndex = ledger.L1_miscData.lastFinalizedBatchIndex + 1n;
    if (ledger.L1_miscData.lastCommittedBatchIndex < targetBatchIndex) {
      throw new Error('No committed batch available to finalize.');
    }
    const batchDataParams: BatchDataParams = {
      contract: ctx.contract,
      contractAddress: ctx.contractAddress,
      contractState,
      ledger,
      batchHash,
    };
    const batchPublicData = await buildBatchPublicData(batchDataParams);
    const digest = hashBatchPublicDataV1Full(batchPublicData);
    warnIfBatchDigestArtifactMismatch(batchPublicData, digest);
    const signatures = buildSignatureVector(digest);
    const signerBitmap = DEFAULT_SIGNER_BITMAP;
    const finalizeTimestamp = 0n;

    const tx = await bridgeContract.callTx.finalizeBatch(
      batchPublicData,
      signatures,
      signerBitmap,
      finalizeTimestamp,
    );
    const txHash = tx.public.txHash;
    const batchIndexStr = batchPublicData.batchIndex.toString();
    const result: FinalizeBatchFromLedgerResult = {
      txHash,
      batchIndex: batchIndexStr,
      status: 'submitted',
    };
    if (!executorContext && opts.json) {
      console.log(JSON.stringify(result));
    } else if (!executorContext) {
      console.log('finalizeBatch txHash:', txHash);
      console.log('batch index:', batchIndexStr);
    }
    return result;
  });
}

/** Single wallet session: ensure pending batch, then run callback with (contractState, ledger, batchHash, bridgeContract, contract, contractAddress). */
async function withLedgerAndBridgeContract<T>(
  cliConfig: CliConfig,
  executorContext: ExecutorContext | undefined,
  fn: (ctx: {
    contractState: ContractState;
    ledger: BridgeLedger;
    batchHash: Uint8Array;
    bridgeContract: DeployedBridgeContract;
    contract: Bridge.Contract<BridgePrivateState>;
    contractAddress: string;
  }) => Promise<T>,
): Promise<T> {
  const { config, contractAddress } = cliConfig;
  const provider = indexerPublicDataProvider(config.indexer, config.indexerWS);
  const contract = new Bridge.Contract<BridgePrivateState>(witnesses);

  if (executorContext) {
    const { providers, bridgeContract } = executorContext;
    const poller = providers.publicDataProvider ?? provider;
    if (!poller) throw new Error('Public data provider is not available');
    const ensureParams: EnsureBatchParams = {
      contract,
      contractAddress,
      bridgeContract,
      publicDataProvider: poller,
    };
    const { contractState, ledger, batchHash } =
      await ensurePendingBatch(ensureParams);
    return await fn({
      contractState,
      ledger,
      batchHash,
      bridgeContract,
      contract,
      contractAddress,
    });
  }

  const walletSeed = getWalletSeedFromEnv();
  const logPath = path.resolve(
    currentDir,
    '..',
    'logs',
    'bridge-cli',
    `${new Date().toISOString()}.log`,
  );
  const logger = await createLogger(logPath);
  api.setLogger(logger);

  const isHex =
    /^[0-9a-fA-F]{64}$/.test(walletSeed) ||
    /^0x[0-9a-fA-F]+$/.test(walletSeed);
  const walletContext = isHex
    ? await api.buildWalletFromHexSeed(config, walletSeed.replace(/^0x/, ''))
    : await api.buildWalletAndWaitForFunds(config, walletSeed);
  try {
    const providers = await api.configureProviders(walletContext, config);
    const poller = providers.publicDataProvider ?? provider;
    if (!poller) throw new Error('Public data provider is not available');
    const bridgeContract = await api.joinContract(providers, contractAddress);
    const ensureParams: EnsureBatchParams = {
      contract,
      contractAddress,
      bridgeContract,
      publicDataProvider: poller,
    };
    const { contractState, ledger, batchHash } =
      await ensurePendingBatch(ensureParams);
    return await fn({
      contractState,
      ledger,
      batchHash,
      bridgeContract,
      contract,
      contractAddress,
    });
  } finally {
    await api.closeWallet(walletContext);
  }
}

/** Submit finalizeBatch with the given four arguments. Requires wallet (env). */
export async function runFinalizeBatch(
  cliConfig: CliConfig,
  opts: FinalizeBatchOptions,
  executorContext?: ExecutorContext,
): Promise<FinalizeBatchResult> {
  const { config, contractAddress } = cliConfig;
  const { batchPublicData, signatures, signerBitmap, finalizeTimestamp } = opts;

  let walletContext: api.WalletContext | null = null;
  let providers = executorContext?.providers;
  let bridgeContract = executorContext?.bridgeContract;

  if (!providers || !bridgeContract) {
    const walletSeed = getWalletSeedFromEnv();
    const logPath = path.resolve(
      currentDir,
      '..',
      'logs',
      'bridge-cli',
      `${new Date().toISOString()}.log`,
    );
    const logger = await createLogger(logPath);
    api.setLogger(logger);
    const isHex =
      /^[0-9a-fA-F]{64}$/.test(walletSeed) ||
      /^0x[0-9a-fA-F]+$/.test(walletSeed);
    if (isHex) {
      const hex = walletSeed.replace(/^0x/, '');
      walletContext = await api.buildWalletFromHexSeed(config, hex);
    } else {
      walletContext = await api.buildWalletAndWaitForFunds(config, walletSeed);
    }
    providers = await api.configureProviders(walletContext, config);
    bridgeContract = await api.joinContract(providers, contractAddress);
  }

  try {
    const tx = await bridgeContract.callTx.finalizeBatch(
      batchPublicData,
      signatures,
      signerBitmap,
      finalizeTimestamp,
    );
    const txHash = tx.public.txHash;
    const batchIndexStr = batchPublicData.batchIndex.toString();
    const result: FinalizeBatchResult = {
      txHash,
      batchIndex: batchIndexStr,
      status: 'submitted',
    };
    if (!executorContext && opts.json) {
      console.log(JSON.stringify(result));
    } else if (!executorContext) {
      console.log('finalizeBatch txHash:', txHash);
      console.log('batch index:', batchIndexStr);
    }
    return result;
  } finally {
    if (walletContext) {
      await api.closeWallet(walletContext);
    }
  }
}
