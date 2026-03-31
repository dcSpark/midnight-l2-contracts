/**
 * Shared executor context: wallet, providers, and joined bridge contract.
 * Built once at service startup and reused by all wallet-using endpoints.
 */
import * as api from './api.js';
import { type CliConfig, getWalletSeedFromEnv } from './cli-config.js';
import type { BridgeProviders, DeployedBridgeContract } from './common-types.js';

export interface ExecutorContext {
  walletContext: api.WalletContext;
  providers: BridgeProviders;
  bridgeContract: DeployedBridgeContract;
  cliConfig: CliConfig;
}

/**
 * Build wallet from env seed, wait for sync, configure providers, join contract.
 * Does not close the wallet; caller must call api.closeWallet(ctx.walletContext) on shutdown.
 */
export async function buildExecutorContext(cliConfig: CliConfig): Promise<ExecutorContext> {
  const { config, contractAddress } = cliConfig;
  const walletSeed = getWalletSeedFromEnv();
  const isHex =
    /^[0-9a-fA-F]{64}$/.test(walletSeed) || /^0x[0-9a-fA-F]+$/.test(walletSeed);
  await api.checkNodeReachable(config.node);
  const walletContext = isHex
    ? await api.buildWalletFromHexSeed(config, walletSeed.replace(/^0x/, ''))
    : await api.buildWalletAndWaitForFunds(config, walletSeed);
  await api.waitForSync(walletContext.wallet);
  const providers = await api.configureProviders(walletContext, config);
  const bridgeContract = await api.joinContract(providers, contractAddress);
  return {
    walletContext,
    providers,
    bridgeContract,
    cliConfig,
  };
}
