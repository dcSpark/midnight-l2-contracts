/**
 * deploy command: deploy the Bridge contract. Uses network from -n/--network (or MIDNIGHT_NETWORK).
 * Wallet: --deployer-seed <hex> or FUNDING_SEED / MY_PREVIEW_MNEMONIC from env.
 */
import path from 'node:path';
import * as api from '../api.js';
import { type DeployCliConfig, getWalletSeedFromEnv } from '../cli-config.js';
import { createLogger } from '../logger.js';
import { currentDir } from '../config.js';

export interface DeployOptions {
  /** Optional hex seed for deployer wallet (overrides env). */
  deployerSeed?: string;
  /** Machine-readable output. */
  json?: boolean;
}

export async function runDeploy(
  deployConfig: DeployCliConfig,
  opts: DeployOptions = {},
): Promise<void> {
  const { config, networkLabel } = deployConfig;

  const logPath = path.resolve(
    currentDir,
    '..',
    'logs',
    'bridge-cli',
    `${new Date().toISOString()}.log`,
  );
  const logger = await createLogger(logPath);
  api.setLogger(logger);

  const walletSeed =
    opts.deployerSeed?.trim() ?? getWalletSeedFromEnv();

  let walletContext: api.WalletContext | null = null;
  try {
    logger.info(`Deploying bridge contract on ${networkLabel}...`);

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
    const deployed = await api.deploy(providers, { privateState: 0 });
    const address = deployed.deployTxData.public.contractAddress;

    logger.info(`Bridge deployed at: ${address}`);

    if (opts.json) {
      console.log(
        JSON.stringify({
          contractAddress: address,
          networkLabel,
        }),
      );
    } else {
      process.stdout.write(`BRIDGE_ADDRESS=${address}\n`);
      process.stdout.write(`VITE_CONTRACT_ADDRESS="${address}"\n`);
    }
  } finally {
    if (walletContext) {
      await api.closeWallet(walletContext);
    }
  }
}
