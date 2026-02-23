/**
 * commit-batch command: commit a batch (rollup node). Requires wallet (FUNDING_SEED or MY_PREVIEW_MNEMONIC).
 * Caller MUST supply --parent-hash and --batch-hash for the circuit call.
 */
import * as api from '../api.js';
import { type CliConfig, getWalletSeedFromEnv } from '../cli-config.js';
import { createLogger } from '../logger.js';
import path from 'node:path';
import { currentDir } from '../config.js';

export interface CommitBatchOptions {
  parentHash: string; // hex 32 bytes (required)
  batchHash: string; // hex 32 bytes (required)
  json?: boolean;
  outputTx?: boolean; // if true, print finalized tx hex to stdout instead of submitting (future use)
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
): Promise<void> {
  const { config, contractAddress } = cliConfig;

  const parentHash = hexToBytes32(opts.parentHash);
  const batchHash = hexToBytes32(opts.batchHash);

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

  let walletContext: api.WalletContext | null = null;
  try {
    const isHex =
      /^[0-9a-fA-F]{64}$/.test(walletSeed) ||
      /^0x[0-9a-fA-F]+$/.test(walletSeed);
    if (isHex) {
      const hex = walletSeed.replace(/^0x/, '');
      walletContext = await api.buildWalletFromHexSeed(config, hex);
    } else {
      walletContext = await api.buildWalletAndWaitForFunds(config, walletSeed);
    }
    const providers = await api.configureProviders(walletContext, config);
    const bridgeContract = await api.joinContract(providers, contractAddress);

    const tx = await bridgeContract.callTx.commitBatch(parentHash, batchHash);
    const txHash = tx.public.txHash;

    if (opts.json) {
      console.log(
        JSON.stringify({
          txHash,
          batchHash: Buffer.from(batchHash).toString('hex'),
          status: 'submitted',
        }),
      );
    } else {
      console.log('commitBatch txHash:', txHash);
      console.log('batchHash:', Buffer.from(batchHash).toString('hex'));
    }
  } finally {
    if (walletContext) {
      await api.closeWallet(walletContext);
    }
  }
}
