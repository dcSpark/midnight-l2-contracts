/**
 * Interactive CLI run (deploy/join, display state). Used by TUI scripts.
 * For non-interactive commands use the main cli.ts entrypoint (Commander).
 */
import { stdin as input, stdout as output } from 'node:process';
import { createInterface, type Interface } from 'node:readline/promises';
import { type Logger } from 'pino';
import { type StartedDockerComposeEnvironment, type DockerComposeEnvironment } from 'testcontainers';
import { type DeployedBridgeContract, type BridgeProviders } from './common-types.js';
import { type Config, UndeployedConfig } from './config.js';
import * as api from './api.js';
import type { WalletContext } from './api.js';
import 'dotenv/config';

const GENESIS_MINT_WALLET_SEED = '0000000000000000000000000000000000000000000000000000000000000001';

const DEPLOY_OR_JOIN_QUESTION = `
You can do one of the following:
  1. Deploy a new bridge contract
  2. Join an existing contract
  3. Exit
Which would you like to do? `;

const MAIN_LOOP_QUESTION = `
You can do one of the following:
  1. Display bridge state
  2. Exit
Which would you like to do? `;

const join = async (providers: BridgeProviders, rli: Interface): Promise<DeployedBridgeContract> => {
  const contractAddress = await rli.question('What is the contract address (in hex)? ');
  return await api.joinContract(providers, contractAddress);
};

const deployOrJoin = async (
  providers: BridgeProviders,
  rli: Interface,
): Promise<DeployedBridgeContract | null> => {
  while (true) {
    const choice = await rli.question(DEPLOY_OR_JOIN_QUESTION);
    switch (choice) {
      case '1':
        return await api.deploy(providers, { privateState: 0 });
      case '2':
        return await join(providers, rli);
      case '3':
        return null;
      default:
        break;
    }
  }
};

const mainLoop = async (providers: BridgeProviders, rli: Interface): Promise<void> => {
  const bridgeContract = await deployOrJoin(providers, rli);
  if (bridgeContract === null) {
    return;
  }
  while (true) {
    const choice = await rli.question(MAIN_LOOP_QUESTION);
    switch (choice) {
      case '1':
        await api.displayBridgeState(providers, bridgeContract);
        break;
      case '2':
        return;
      default:
        break;
    }
  }
};

const buildWalletFromMnemonic = async (config: Config, rli: Interface): Promise<WalletContext> => {
  const mnemonic = await rli.question('Enter your wallet mnemonic (24 words): ');
  return await api.buildWalletAndWaitForFunds(config, mnemonic);
};

const WALLET_LOOP_QUESTION = `
You can do one of the following:
  1. Build a fresh wallet
  2. Build wallet from a mnemonic
  3. Use mnemonic from .env file
  4. Exit
Which would you like to do? `;

const buildWallet = async (config: Config, rli: Interface): Promise<WalletContext | null> => {
  if (config instanceof UndeployedConfig) {
    return await api.buildWalletFromHexSeed(config, GENESIS_MINT_WALLET_SEED);
  }
  const envMnemonic = process.env.MY_PREVIEW_MNEMONIC;
  while (true) {
    const choice = await rli.question(WALLET_LOOP_QUESTION);
    switch (choice) {
      case '1':
        return await api.buildFreshWallet(config);
      case '2':
        return await buildWalletFromMnemonic(config, rli);
      case '3':
        if (envMnemonic) {
          return await api.buildWalletAndWaitForFunds(config, envMnemonic);
        }
        break;
      case '4':
        return null;
      default:
        break;
    }
  }
};

const mapContainerPort = (env: StartedDockerComposeEnvironment, url: string, containerName: string) => {
  const mappedUrl = new URL(url);
  const container = env.getContainer(containerName);
  mappedUrl.port = String(container.getFirstMappedPort());
  return mappedUrl.toString().replace(/\/+$/, '');
};

export const run = async (
  config: Config,
  logger: Logger,
  dockerEnv?: DockerComposeEnvironment,
): Promise<void> => {
  api.setLogger(logger);
  const rli = createInterface({ input, output, terminal: true });
  let env: StartedDockerComposeEnvironment | undefined;
  let walletContext: WalletContext | null = null;

  if (dockerEnv !== undefined) {
    env = await dockerEnv.up();
    if (config instanceof UndeployedConfig) {
      (config as { indexer: string }).indexer = mapContainerPort(env, config.indexer, 'bridge-indexer');
      (config as { indexerWS: string }).indexerWS = mapContainerPort(env, config.indexerWS, 'bridge-indexer');
      (config as { node: string }).node = mapContainerPort(env, config.node, 'bridge-node');
      (config as { proofServer: string }).proofServer = mapContainerPort(env, config.proofServer, 'bridge-proof-server');
    }
  }

  try {
    walletContext = await buildWallet(config, rli);
    if (walletContext !== null) {
      const providers = await api.configureProviders(walletContext, config);
      await mainLoop(providers, rli);
    }
  } catch (e) {
    if (e instanceof Error) {
      logger.error(`Found error '${e.message}'`);
      logger.debug(`${e.stack}`);
    } else {
      throw e;
    }
  } finally {
    try {
      rli.close();
      rli.removeAllListeners();
    } catch {
      // ignore close errors
    }
    try {
      if (walletContext !== null) {
        await api.closeWallet(walletContext);
      }
    } catch (e) {
      logger.error(`Error closing wallet: ${e}`);
    }
    try {
      if (env !== undefined) {
        await env.down();
      }
    } catch (e) {
      logger.error(`Error shutting down docker environment: ${e}`);
    }
  }
};
