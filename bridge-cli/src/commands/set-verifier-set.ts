/**
 * set-verifier-set command: set the Bridge verifier set (admin). Requires wallet.
 */
import * as api from '../api.js';
import { deriveDefaultVerifierSet } from '../batch-helpers.js';
import { type CliConfig, getWalletSeedFromEnv } from '../cli-config.js';
import { createLogger } from '../logger.js';
import path from 'node:path';
import { currentDir } from '../config.js';
import type { ExecutorContext } from '../executor-context.js';

export interface SetVerifierSetOptions {
  json?: boolean;
}

export interface SetVerifierSetResult {
  txHash: string;
  status: string;
}

export async function runSetVerifierSet(
  cliConfig: CliConfig,
  opts: SetVerifierSetOptions,
  executorContext?: ExecutorContext,
): Promise<SetVerifierSetResult> {
  const { config, contractAddress } = cliConfig;

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
    const verifierSet = deriveDefaultVerifierSet();
    const tx = await bridgeContract.callTx.setVerifierSet(verifierSet);
    const txHash = tx.public.txHash;
    const result: SetVerifierSetResult = { txHash, status: 'submitted' };
    if (!executorContext && opts.json) {
      console.log(JSON.stringify(result));
    } else if (!executorContext) {
      console.log('setVerifierSet txHash:', txHash);
    }
    return result;
  } finally {
    if (walletContext) {
      await api.closeWallet(walletContext);
    }
  }
}
