/**
 * relay-withdraw-night-with-proof command: relay an L2->L1 NIGHT withdrawal with merkle proof.
 */
import * as api from '../api.js';
import { type CliConfig, getWalletSeedFromEnv } from '../cli-config.js';
import { createLogger } from '../logger.js';
import path from 'node:path';
import { currentDir } from '../config.js';
import type { ExecutorContext } from '../executor-context.js';

export interface RelayWithdrawNightWithProofOptions {
  l2Sender: string; // hex 32 bytes (64 hex chars)
  recipient: string; // hex 32 bytes (64 hex chars)
  amount: string; // decimal string
  batchIndex: string; // decimal string
  nonce: string; // decimal string
  indexBits: string; // JSON boolean[] (length 16), LSB-first
  siblings: string; // JSON string[] of hex32 (length 16)
  json?: boolean;
}

export interface RelayWithdrawNightWithProofResult {
  txHash: string;
  amount: string;
  batchIndex: string;
  nonce: string;
  status: string;
}

function hexToBytes32(hex: string, label: string): Uint8Array {
  const s = hex.replace(/^0x/, '').trim();
  if (s.length !== 64 || !/^[0-9a-fA-F]+$/.test(s)) {
    throw new Error(`${label} must be 32 bytes (64 hex chars)`);
  }
  return new Uint8Array(Buffer.from(s, 'hex'));
}

function parseIndexBits(json: string): boolean[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new Error(`Invalid JSON for --index-bits: ${error}`);
  }
  if (!Array.isArray(raw) || raw.length !== 16 || raw.some((v) => typeof v !== 'boolean')) {
    throw new Error('--index-bits must be a JSON array of 16 booleans (LSB-first)');
  }
  return raw as boolean[];
}

function parseSiblings(json: string): Uint8Array[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new Error(`Invalid JSON for --siblings: ${error}`);
  }
  if (!Array.isArray(raw) || raw.length !== 16) {
    throw new Error('--siblings must be a JSON array of 16 hex strings');
  }
  return raw.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new Error(`--siblings[${index}] must be a hex string`);
    }
    return hexToBytes32(entry, `--siblings[${index}]`);
  });
}

export async function runRelayWithdrawNightWithProof(
  cliConfig: CliConfig,
  opts: RelayWithdrawNightWithProofOptions,
  executorContext?: ExecutorContext,
): Promise<RelayWithdrawNightWithProofResult> {
  const { config, contractAddress } = cliConfig;
  const l2Sender = hexToBytes32(opts.l2Sender, '--l2-sender');
  const recipient = hexToBytes32(opts.recipient, '--recipient');
  const amount = BigInt(opts.amount);
  const batchIndex = BigInt(opts.batchIndex);
  const nonce = BigInt(opts.nonce);
  if (amount <= 0n) {
    throw new Error('--amount must be positive');
  }
  if (batchIndex < 0n) {
    throw new Error('--batch-index must be non-negative');
  }
  if (nonce < 0n) {
    throw new Error('--nonce must be non-negative');
  }
  const indexBits = parseIndexBits(opts.indexBits);
  const siblings = parseSiblings(opts.siblings);

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
      walletContext = await api.buildWalletFromHexSeed(config, walletSeed.replace(/^0x/, ''));
    } else {
      walletContext = await api.buildWalletAndWaitForFunds(config, walletSeed);
    }
    providers = await api.configureProviders(walletContext, config);
    bridgeContract = await api.joinContract(providers, contractAddress);
  }

  try {
    const tx = await bridgeContract.callTx.relayWithdrawNIGHTWithProof(
      l2Sender,
      recipient,
      amount,
      {
        batchIndex,
        nonce,
        indexBits,
        siblings,
      },
    );
    const txHash = tx.public.txHash;
    const result: RelayWithdrawNightWithProofResult = {
      txHash,
      amount: amount.toString(),
      batchIndex: batchIndex.toString(),
      nonce: nonce.toString(),
      status: 'submitted',
    };
    if (!executorContext && opts.json) {
      console.log(JSON.stringify(result));
    } else if (!executorContext) {
      console.log('relayWithdrawNIGHTWithProof txHash:', txHash);
    }
    return result;
  } finally {
    if (walletContext) {
      await api.closeWallet(walletContext);
    }
  }
}
