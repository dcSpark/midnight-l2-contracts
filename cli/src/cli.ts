// This file is part of midnightntwrk/example-counter.
// Copyright (C) 2025 Midnight Foundation
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0 (the "License");
// You may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { nativeToken } from '@midnight-ntwrk/ledger';
import { type Resource } from '@midnight-ntwrk/wallet';
import { type Wallet } from '@midnight-ntwrk/wallet-api';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface, type Interface } from 'node:readline/promises';
import { type Logger } from 'pino';
import * as Rx from 'rxjs';
import { type DockerComposeEnvironment, type StartedDockerComposeEnvironment } from 'testcontainers';
import * as api from './api';
import { type DeployedL2Contract, type L2Providers } from './common-types';
import { type Config, StandaloneConfig } from './config';

let logger: Logger;

/**
 * This seed gives access to tokens minted in the genesis block of a local development node - only
 * used in standalone networks to build a wallet with initial funds.
 */
const GENESIS_MINT_WALLET_SEED = '0000000000000000000000000000000000000000000000000000000000000001';

const DEPLOY_OR_JOIN_QUESTION = `
You can do one of the following:
  1. Deploy a new L2 contract
  2. Join an existing L2 contract
  3. Exit
Which would you like to do? `;

const MAIN_LOOP_QUESTION = `
You can do one of the following:
  1. Update state root
  2. Display current state root value
  3. Deposit to bridge
  4. Withdraw from bridge
  5. Exit
Which would you like to do? `;

const join = async (providers: L2Providers, rli: Interface): Promise<DeployedL2Contract> => {
  let contractAddress: string | undefined;
  const deploymentPath = path.resolve(process.cwd(), 'deployment.json');
  try {
    const data = await fs.readFile(deploymentPath, 'utf-8');
    const parsed: unknown = JSON.parse(data);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'contractAddress' in parsed &&
      typeof (parsed as { contractAddress?: unknown }).contractAddress === 'string'
    ) {
      contractAddress = (parsed as { contractAddress: string }).contractAddress;
      logger.info(`Using contract address from deployment.json: ${contractAddress}`);
    } else {
      logger.warn('deployment.json found but contractAddress field is missing or invalid.');
    }
  } catch (err) {
    logger.warn(`Could not read deployment.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!contractAddress) {
    contractAddress = await rli.question('What is the contract address (in hex)? ');
  }
  return await api.joinContract(providers, contractAddress);
};

const deployOrJoin = async (providers: L2Providers, rli: Interface): Promise<DeployedL2Contract | null> => {
  while (true) {
    const choice = await rli.question(DEPLOY_OR_JOIN_QUESTION);
    switch (choice) {
      case '1':
        return await api.deploy(providers, { privateState: 0 });
      case '2':
        return await join(providers, rli);
      case '3':
        logger.info('Exiting...');
        return null;
      default:
        logger.error(`Invalid choice: ${choice}`);
    }
  }
};

function hexStringToUint8Array(hex: string): Uint8Array {
  if (hex.startsWith('0x') || hex.startsWith('0X')) {
    hex = hex.slice(2);
  }
  // pad with zeros or slice to 64 chars
  if (hex.length < 64) {
    hex = hex.padEnd(64, '0');
  } else if (hex.length > 64) {
    hex = hex.slice(0, 64);
  }
  const arr = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

const update = async (l2Contract: DeployedL2Contract, rli: Interface): Promise<void> => {
  let newRootHex = await rli.question('Enter new state root (hex string, e.g. 0xabc...): ');
  await api.updateStateRoot(l2Contract, hexStringToUint8Array(newRootHex));
};

const depositToBridge = async (l2Contract: DeployedL2Contract, rli: Interface, wallet: Wallet): Promise<void> => {
  // Get wallet balance before deposit
  const walletStateBefore = await Rx.firstValueFrom(wallet.state());
  const balanceBefore = walletStateBefore.balances[nativeToken()] ?? 0n;
  logger.info(`Wallet balance before deposit: ${balanceBefore.toString()}`);

  let amountStr = await rli.question('Enter amount to deposit (as integer): ');
  let amount: bigint;
  try {
    amount = BigInt(amountStr);
  } catch {
    logger.error('Invalid amount. Please enter a valid integer.');
    return;
  }
  let l2ReceiverHex = await rli.question('Enter L2 receiver public key (hex string, e.g. 0xabc...): ');
  const l2Receiver = hexStringToUint8Array(l2ReceiverHex);
  const depositId = await api.deposit(l2Contract, amount, l2Receiver);
  logger.info(`Deposit successful. Your depositId is: ${depositId}`);

  // Get wallet balance after deposit
  const walletStateAfter = await Rx.firstValueFrom(wallet.state());
  const balanceAfter = walletStateAfter.balances[nativeToken()] ?? 0n;
  logger.info(`Wallet balance after deposit: ${balanceAfter.toString()}`);
};

const withdrawFromBridge = async (l2Contract: DeployedL2Contract, rli: Interface, wallet: Wallet): Promise<void> => {
  // Get wallet balance before withdraw
  const walletStateBefore = await Rx.firstValueFrom(wallet.state());
  const balanceBefore = walletStateBefore.balances[nativeToken()] ?? 0n;
  logger.info(`Wallet balance before withdraw: ${balanceBefore.toString()}`);

  let depositIdStr = await rli.question('Enter depositId to withdraw: ');
  let depositId: bigint;
  try {
    depositId = BigInt(depositIdStr);
  } catch {
    logger.error('Invalid depositId. Please enter a valid integer.');
    return;
  }
  // Use wallet address as l1Receiver
  const walletState = await Rx.firstValueFrom(wallet.state());
  const l1Receiver = hexStringToUint8Array(walletState.address);

  await api.withdraw(l2Contract, depositId, l1Receiver);

  // Get wallet balance after withdraw
  const walletStateAfter = await Rx.firstValueFrom(wallet.state());
  const balanceAfter = walletStateAfter.balances[nativeToken()] ?? 0n;
  logger.info(`Wallet balance after withdraw: ${balanceAfter.toString()}`);
};

const mainLoop = async (providers: L2Providers, rli: Interface, wallet: Wallet): Promise<void> => {
  const l2Contract = await deployOrJoin(providers, rli);
  if (l2Contract === null) {
    return;
  }
  while (true) {
    const choice = await rli.question(MAIN_LOOP_QUESTION);
    switch (choice) {
      case '1':
        await update(l2Contract, rli);
        break;
      case '2':
        await api.displayStateRoot(providers, l2Contract);
        break;
      case '3':
        await depositToBridge(l2Contract, rli, wallet);
        break;
      case '4':
        await withdrawFromBridge(l2Contract, rli, wallet);
        break;
      case '5':
        logger.info('Exiting...');
        return;
      default:
        logger.error(`Invalid choice: ${choice}`);
    }
  }
};

const buildWalletFromSeed = async (config: Config, rli: Interface): Promise<Wallet & Resource> => {
  let seed = process.env.WALLET_SEED;
  if (!seed) {
    seed = await rli.question('Enter your wallet seed: ');
  } else {
    logger.info('Using wallet seed from WALLET_SEED environment variable.');
  }
  return await api.buildWalletAndWaitForFunds(config, seed, '');
};

const WALLET_LOOP_QUESTION = `
You can do one of the following:
  1. Build a fresh wallet
  2. Build wallet from a seed
  3. Exit
Which would you like to do? `;

const buildWallet = async (config: Config, rli: Interface): Promise<(Wallet & Resource) | null> => {
  if (config instanceof StandaloneConfig) {
    return await api.buildWalletAndWaitForFunds(config, GENESIS_MINT_WALLET_SEED, '');
  }
  while (true) {
    const choice = await rli.question(WALLET_LOOP_QUESTION);
    switch (choice) {
      case '1':
        return await api.buildFreshWallet(config);
      case '2':
        return await buildWalletFromSeed(config, rli);
      case '3':
        logger.info('Exiting...');
        return null;
      default:
        logger.error(`Invalid choice: ${choice}`);
    }
  }
};

const mapContainerPort = (env: StartedDockerComposeEnvironment, url: string, containerName: string) => {
  const mappedUrl = new URL(url);
  const container = env.getContainer(containerName);

  mappedUrl.port = String(container.getFirstMappedPort());

  return mappedUrl.toString().replace(/\/+$/, '');
};

export const run = async (config: Config, _logger: Logger, dockerEnv?: DockerComposeEnvironment): Promise<void> => {
  logger = _logger;
  api.setLogger(_logger);
  const rli = createInterface({ input, output, terminal: true });
  let env;
  if (dockerEnv !== undefined) {
    env = await dockerEnv.up();

    if (config instanceof StandaloneConfig) {
      config.indexer = mapContainerPort(env, config.indexer, 'midnight-indexer');
      config.indexerWS = mapContainerPort(env, config.indexerWS, 'midnight-indexer');
      config.node = mapContainerPort(env, config.node, 'midnight-node');
      config.proofServer = mapContainerPort(env, config.proofServer, 'midnight-proof-server');
    }
  }
  const wallet = await buildWallet(config, rli);
  try {
    if (wallet !== null) {
      const providers = await api.configureProviders(wallet, config);
      await mainLoop(providers, rli, wallet);
    }
  } catch (e) {
    if (e instanceof Error) {
      logger.error(`Found error '${e.message}'`);
      logger.info('Exiting...');
      logger.debug(`${e.stack}`);
    } else {
      throw e;
    }
  } finally {
    try {
      rli.close();
      rli.removeAllListeners();
    } catch (e) {
      logger.error(`Error closing readline interface: ${e}`);
    } finally {
      try {
        if (wallet !== null) {
          await wallet.close();
        }
      } catch (e) {
        logger.error(`Error closing wallet: ${e}`);
      } finally {
        try {
          if (env !== undefined) {
            await env.down();
            logger.info('Goodbye');
          }
        } catch (e) {
          logger.error(`Error shutting down docker environment: ${e}`);
        }
      }
    }
  }
};
