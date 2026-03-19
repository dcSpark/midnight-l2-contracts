/**
 * deposit command: call depositNIGHTUnshielded on the Bridge contract (L1 → L2 deposit).
 * Requires wallet (FUNDING_SEED or MY_PREVIEW_MNEMONIC). Caller specifies amount, optional L2 recipient, gas limit, and timestamp.
 */
import { encodeCoinPublicKey } from '@midnight-ntwrk/compact-runtime';
import { bech32m } from 'bech32';
import path from 'node:path';
import * as api from '../api.js';
import { type CliConfig, getWalletSeedFromEnv } from '../cli-config.js';
import { currentDir } from '../config.js';
import { createLogger } from '../logger.js';
import type { ExecutorContext } from '../executor-context.js';

const SOV_HRP = 'sov';

export interface DepositOptions {
  /** Amount in NIGHT (decimal string). */
  amount: string;
  /** L2 recipient: 32-byte hex (64 hex chars) or sov-format address (e.g. sov1...). If omitted, uses the wallet's coin public key (deposit to self on L2). */
  l2Recipient?: string;
  /** Gas limit for L2 execution (decimal string). Default 100000. */
  gasLimit?: string;
  /** Timestamp for the deposit message (decimal string). Default 0. */
  timestamp?: string;
  /** Machine-readable output. */
  json?: boolean;
}

export interface DepositResult {
  txHash: string;
  amount: string;
  gasLimit: string;
  timestamp: string;
  status: string;
}

/**
 * Converts an L2 recipient string to 32 bytes for the contract.
 * Accepts either sov-format (sov1...) or 32-byte hex (64 hex chars).
 * Sov addresses are 28 bytes; we pad with 4 zero bytes so the rollup credits the same sov1 address.
 */
function l2RecipientToBytes32(input: string): Uint8Array {
  const s = input.trim();
  if (s.startsWith(`${SOV_HRP}1`)) {
    let decoded: { prefix: string; words: number[] };
    try {
      decoded = bech32m.decode(s);
    } catch (e) {
      throw new Error(`Invalid sov address: ${(e as Error).message}`);
    }
    if (decoded.prefix !== SOV_HRP) {
      throw new Error(`sov address must have prefix "sov", got "${decoded.prefix}"`);
    }
    const bytes = bech32m.fromWords(decoded.words);
    if (bytes.length !== 28) {
      throw new Error(`sov address must decode to 28 bytes, got ${bytes.length}`);
    }
    const out = new Uint8Array(32);
    out.set(bytes, 0);
    return out;
  }
  const hex = s.replace(/^0x/, '');
  if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('l2Recipient must be 32 bytes (64 hex chars) or a sov-format address (e.g. sov1...)');
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

export async function runDeposit(
  cliConfig: CliConfig,
  opts: DepositOptions,
  executorContext?: ExecutorContext,
): Promise<DepositResult> {
  const { config, contractAddress } = cliConfig;

  const amount = BigInt(opts.amount);
  if (amount <= 0n) {
    throw new Error('--amount must be positive');
  }
  const gasLimit = opts.gasLimit !== undefined ? BigInt(opts.gasLimit) : 100_000n;
  const timestamp = opts.timestamp !== undefined ? BigInt(opts.timestamp) : 0n;

  let walletContext: api.WalletContext | null = null;
  let providers = executorContext?.providers;
  let bridgeContract = executorContext?.bridgeContract;

  if (!providers || !bridgeContract) {
    const logPath = path.resolve(currentDir, '..', 'logs', 'bridge-cli', `${new Date().toISOString()}.log`);
    const logger = await createLogger(logPath);
    api.setLogger(logger);
    const walletSeed = getWalletSeedFromEnv();
    const isHex =
      /^[0-9a-fA-F]{64}$/.test(walletSeed) || /^0x[0-9a-fA-F]+$/.test(walletSeed);
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
    let l2Recipient: Uint8Array;
    if (opts.l2Recipient !== undefined) {
      l2Recipient = l2RecipientToBytes32(opts.l2Recipient);
    } else {
      if (!providers.walletProvider) {
        throw new Error('Wallet provider is not available');
      }
      const coinPublicKey = providers.walletProvider.getCoinPublicKey();
      if (!coinPublicKey) {
        throw new Error('Wallet coin public key is not available');
      }
      l2Recipient = encodeCoinPublicKey(coinPublicKey);
    }

    const tx = await bridgeContract.callTx.depositNIGHTUnshielded(
      amount,
      l2Recipient,
      gasLimit,
      timestamp,
    );
    const txHash = tx.public.txHash;
    const result: DepositResult = {
      txHash,
      amount: opts.amount,
      gasLimit: gasLimit.toString(),
      timestamp: timestamp.toString(),
      status: 'submitted',
    };
    if (!executorContext && opts.json) {
      console.log(JSON.stringify(result));
    } else if (!executorContext) {
      console.log('depositNIGHTUnshielded txHash:', txHash);
    }
    return result;
  } finally {
    if (walletContext) {
      await api.closeWallet(walletContext);
    }
  }
}
