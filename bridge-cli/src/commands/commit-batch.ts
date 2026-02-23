/**
 * commit-batch command: commit a batch (rollup node). Requires wallet (FUNDING_SEED or MY_PREVIEW_MNEMONIC).
 * Caller MUST supply --parent-hash and --batch-hash for the circuit call.
 */
import * as api from '../api.js';
import { type CliConfig, getWalletSeedFromEnv } from '../cli-config.js';
import { createLogger } from '../logger.js';
import path from 'node:path';
import { currentDir } from '../config.js';
import type { ExecutorContext } from '../executor-context.js';

export interface CommitBatchOptions {
  parentHash: string; // hex 32 bytes (required)
  batchHash: string; // hex 32 bytes (required)
  json?: boolean;
  outputTx?: boolean; // if true, print finalized tx hex to stdout instead of submitting (future use)
}

export interface CommitBatchResult {
  txHash: string;
  batchHash: string;
  status: string;
}

function hexToBytes32(hex: string): Uint8Array {
  const s = hex.replace(/^0x/, '').trim();
  if (s.length !== 64 || !/^[0-9a-fA-F]+$/.test(s)) {
    throw new Error('Must be 32 bytes (64 hex chars)');
  }
  return new Uint8Array(Buffer.from(s, 'hex'));
}

export async function runCommitBatch(
  cliConfig: CliConfig,
  opts: CommitBatchOptions,
  executorContext?: ExecutorContext,
): Promise<CommitBatchResult> {
  const { config, contractAddress } = cliConfig;

  const parentHash = hexToBytes32(opts.parentHash);
  const batchHash = hexToBytes32(opts.batchHash);

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
    const tx = await bridgeContract.callTx.commitBatch(parentHash, batchHash);
    const txHash = tx.public.txHash;
    const batchHashHex = Buffer.from(batchHash).toString('hex');
    const result: CommitBatchResult = {
      txHash,
      batchHash: batchHashHex,
      status: 'submitted',
    };
    if (!executorContext && opts.json) {
      console.log(JSON.stringify(result));
    } else if (!executorContext) {
      console.log('commitBatch txHash:', txHash);
      console.log('batchHash:', batchHashHex);
    }
    return result;
  } finally {
    if (walletContext) {
      await api.closeWallet(walletContext);
    }
  }
}
