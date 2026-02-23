/**
 * deposit command: call depositNIGHTUnshielded on the Bridge contract (L1 → L2 deposit).
 * Requires wallet (FUNDING_SEED or MY_PREVIEW_MNEMONIC). Caller specifies amount, optional L2 recipient, gas limit, and timestamp.
 */
import { encodeCoinPublicKey } from '@midnight-ntwrk/compact-runtime';
import path from 'node:path';
import * as api from '../api.js';
import { type CliConfig, getWalletSeedFromEnv } from '../cli-config.js';
import { currentDir } from '../config.js';
import { createLogger } from '../logger.js';

export interface DepositOptions {
  /** Amount in NIGHT (decimal string). */
  amount: string;
  /** L2 recipient as 32-byte hex (64 hex chars). If omitted, uses the wallet's coin public key (deposit to self on L2). */
  l2Recipient?: string;
  /** Gas limit for L2 execution (decimal string). Default 100000. */
  gasLimit?: string;
  /** Timestamp for the deposit message (decimal string). Default 0. */
  timestamp?: string;
  /** Machine-readable output. */
  json?: boolean;
}

function hexToBytes32(hex: string): Uint8Array {
  const s = hex.replace(/^0x/, '').trim();
  if (s.length !== 64 || !/^[0-9a-fA-F]+$/.test(s)) {
    throw new Error('--l2-recipient must be 32 bytes (64 hex chars)');
  }
  return new Uint8Array(Buffer.from(s, 'hex'));
}

export async function runDeposit(cliConfig: CliConfig, opts: DepositOptions): Promise<void> {
  const { config, contractAddress } = cliConfig;

  const amount = BigInt(opts.amount);
  if (amount <= 0n) {
    throw new Error('--amount must be positive');
  }
  const gasLimit = opts.gasLimit !== undefined ? BigInt(opts.gasLimit) : 100_000n;
  const timestamp = opts.timestamp !== undefined ? BigInt(opts.timestamp) : 0n;

  const walletSeed = getWalletSeedFromEnv();
  const logPath = path.resolve(currentDir, '..', 'logs', 'bridge-cli', `${new Date().toISOString()}.log`);
  const logger = await createLogger(logPath);
  api.setLogger(logger);

  let walletContext: api.WalletContext | null = null;
  try {
    const isHex =
      /^[0-9a-fA-F]{64}$/.test(walletSeed) || /^0x[0-9a-fA-F]+$/.test(walletSeed);
    if (isHex) {
      const hex = walletSeed.replace(/^0x/, '');
      walletContext = await api.buildWalletFromHexSeed(config, hex);
    } else {
      walletContext = await api.buildWalletAndWaitForFunds(config, walletSeed);
    }
    const providers = await api.configureProviders(walletContext, config);

    let l2Recipient: Uint8Array;
    if (opts.l2Recipient !== undefined) {
      l2Recipient = hexToBytes32(opts.l2Recipient);
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

    const bridgeContract = await api.joinContract(providers, contractAddress);
    const tx = await bridgeContract.callTx.depositNIGHTUnshielded(
      amount,
      l2Recipient,
      gasLimit,
      timestamp,
    );
    const txHash = tx.public.txHash;

    if (opts.json) {
      console.log(
        JSON.stringify({
          txHash,
          amount: opts.amount,
          gasLimit: gasLimit.toString(),
          timestamp: timestamp.toString(),
          status: 'submitted',
        }),
      );
    } else {
      console.log('depositNIGHTUnshielded txHash:', txHash);
    }
  } finally {
    if (walletContext) {
      await api.closeWallet(walletContext);
    }
  }
}
