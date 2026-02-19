/**
 * set-verifier-set command: set the Bridge verifier set (admin). Requires wallet.
 */
import * as api from '../api.js';
import { deriveDefaultVerifierSet } from '../batch-helpers.js';
import { type CliConfig, getWalletSeedFromEnv } from '../cli-config.js';
import { createLogger } from '../logger.js';
import path from 'node:path';
import { currentDir } from '../config.js';

export interface SetVerifierSetOptions {
  json?: boolean;
}

export async function runSetVerifierSet(
  cliConfig: CliConfig,
  opts: SetVerifierSetOptions,
): Promise<void> {
  const { config, contractAddress } = cliConfig;
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

    const verifierSet = deriveDefaultVerifierSet();
    const tx = await bridgeContract.callTx.setVerifierSet(verifierSet);
    const txHash = tx.public.txHash;

    if (opts.json) {
      console.log(JSON.stringify({ txHash, status: 'submitted' }));
    } else {
      console.log('setVerifierSet txHash:', txHash);
    }
  } finally {
    if (walletContext) {
      await api.closeWallet(walletContext);
    }
  }
}
