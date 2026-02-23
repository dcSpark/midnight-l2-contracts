/**
 * claim-l1-withdrawal-unshielded command: claim L1 withdrawal (user). Requires wallet.
 */
import * as api from '../api.js';
import { type CliConfig, getWalletSeedFromEnv } from '../cli-config.js';
import { createLogger } from '../logger.js';
import path from 'node:path';
import { currentDir } from '../config.js';

export interface ClaimL1WithdrawalUnshieldedOptions {
  recipient: string; // hex 32 bytes (64 hex chars)
  amount: string;   // decimal string
  json?: boolean;
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
): Promise<void> {
  const { config, contractAddress } = cliConfig;
  const recipient = hexToBytes32(opts.recipient);
  const amount = BigInt(opts.amount);
  if (amount <= 0n) {
    throw new Error('--amount must be positive');
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

    const tx = await bridgeContract.callTx.claimL1WithdrawalUnshielded(
      recipient,
      amount,
    );
    const txHash = tx.public.txHash;

    if (opts.json) {
      console.log(
        JSON.stringify({
          txHash,
          recipient: opts.recipient,
          amount: opts.amount,
          status: 'submitted',
        }),
      );
    } else {
      console.log('claimL1WithdrawalUnshielded txHash:', txHash);
    }
  } finally {
    if (walletContext) {
      await api.closeWallet(walletContext);
    }
  }
}
