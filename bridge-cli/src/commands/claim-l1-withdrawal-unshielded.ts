/**
 * claim-l1-withdrawal-unshielded command: claim L1 withdrawal (user). Requires wallet.
 */
import * as api from '../api.js';
import { type CliConfig, getWalletSeedFromEnv } from '../cli-config.js';
import { createLogger } from '../logger.js';
import path from 'node:path';
import { currentDir } from '../config.js';
import type { ExecutorContext } from '../executor-context.js';

export interface ClaimL1WithdrawalUnshieldedOptions {
  recipient: string; // hex 32 bytes (64 hex chars)
  amount: string;   // decimal string
  json?: boolean;
}

export interface ClaimL1WithdrawalUnshieldedResult {
  txHash: string;
  recipient: string;
  amount: string;
  status: string;
}

function hexToBytes32(hex: string): Uint8Array {
  const s = hex.replace(/^0x/, '').trim();
  if (s.length !== 64 || !/^[0-9a-fA-F]+$/.test(s)) {
    throw new Error('--recipient must be 32 bytes (64 hex chars)');
  }
  return new Uint8Array(Buffer.from(s, 'hex'));
}

export async function runClaimL1WithdrawalUnshielded(
  cliConfig: CliConfig,
  opts: ClaimL1WithdrawalUnshieldedOptions,
  executorContext?: ExecutorContext,
): Promise<ClaimL1WithdrawalUnshieldedResult> {
  const { config, contractAddress } = cliConfig;
  const recipient = hexToBytes32(opts.recipient);
  const amount = BigInt(opts.amount);
  if (amount <= 0n) {
    throw new Error('--amount must be positive');
  }

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
    const tx = await bridgeContract.callTx.claimL1WithdrawalUnshielded(
      recipient,
      amount,
    );
    const txHash = tx.public.txHash;
    const result: ClaimL1WithdrawalUnshieldedResult = {
      txHash,
      recipient: opts.recipient,
      amount: opts.amount,
      status: 'submitted',
    };
    if (!executorContext && opts.json) {
      console.log(JSON.stringify(result));
    } else if (!executorContext) {
      console.log('claimL1WithdrawalUnshielded txHash:', txHash);
    }
    return result;
  } finally {
    if (walletContext) {
      await api.closeWallet(walletContext);
    }
  }
}
