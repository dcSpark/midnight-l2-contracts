/**
 * deploy command: deploy the Bridge contract. Uses network from -n/--network (or MIDNIGHT_NETWORK).
 * Wallet: --deployer-seed <hex> or FUNDING_SEED / MY_PREVIEW_MNEMONIC from env.
 */
import path from 'node:path';
import * as api from '../api.js';
import { type DeployCliConfig, getWalletSeedFromEnv } from '../cli-config.js';
import { createLogger } from '../logger.js';
import { currentDir } from '../config.js';
import type { ExecutorContext } from '../executor-context.js';

export interface DeployOptions {
  /** Optional hex seed for deployer wallet (overrides env). */
  deployerSeed?: string;
  /** Machine-readable output. */
  json?: boolean;
}

export interface DeployResult {
  contractAddress: string;
  networkLabel: string;
}

export async function runDeploy(
  deployConfig: DeployCliConfig,
  opts: DeployOptions = {},
  executorContext?: ExecutorContext,
): Promise<DeployResult> {
  const { config, networkLabel } = deployConfig;

  let walletContext: api.WalletContext | null = null;
  let providers = executorContext?.providers;

  if (!providers) {
    const logPath = path.resolve(
      currentDir,
      '..',
      'logs',
      'bridge-cli',
      `${new Date().toISOString()}.log`,
    );
    const logger = await createLogger(logPath);
    api.setLogger(logger);
    logger.info(`Deploying bridge contract on ${networkLabel}...`);
    const walletSeed = opts.deployerSeed?.trim() ?? getWalletSeedFromEnv();
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
  }

  try {
    const deployed = await api.deploy(providers, { privateState: 0 });
    const address = deployed.deployTxData.public.contractAddress;
    const result: DeployResult = { contractAddress: address, networkLabel };
    if (!executorContext) {
      if (opts.json) {
        console.log(JSON.stringify(result));
      } else {
        process.stdout.write(`BRIDGE_ADDRESS=${address}\n`);
        process.stdout.write(`VITE_CONTRACT_ADDRESS="${address}"\n`);
      }
    }
    return result;
  } finally {
    if (walletContext) {
      await api.closeWallet(walletContext);
    }
  }
}
