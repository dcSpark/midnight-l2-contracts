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

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { type ContractAddress } from '@midnight-ntwrk/compact-runtime';
import {
  encodeContractAddress,
  nativeToken,
  type TransactionId,
  type ShieldedCoinInfo,
  type UnprovenTransaction,
} from '@midnight-ntwrk/ledger-v6';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import {
  type FinalizedTxData,
  type MidnightProvider,
  type WalletProvider,
  type BalancedProvingRecipe,
} from '@midnight-ntwrk/midnight-js-types';
import { assertIsContractAddress, toHex } from '@midnight-ntwrk/midnight-js-utils';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { NetworkId } from '@midnight-ntwrk/wallet-sdk-abstractions';
import { ShieldedWallet, type CustomizedShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { webcrypto } from 'crypto';
import { L2, L2PrivateState, witnesses } from 'midnight-l2-contracts';
import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import { type Logger } from 'pino';
import * as Rx from 'rxjs';
import { WebSocket } from 'ws';
import { type DeployedL2Contract, type L2Contract, L2PrivateStateId, type L2Providers } from './common-types';
import { type Config, contractConfig } from './config';
import { Signer } from './signer';

let logger: Logger;
// @ts-expect-error: It's needed to enable WebSocket usage through apollo
globalThis.WebSocket = WebSocket;

// Type alias for the shielded wallet
type Wallet = CustomizedShieldedWallet;
type Resource = { close(): Promise<void> };

// Helper to get native token raw type for balance lookups
const nativeTokenRaw = () => nativeToken().raw;

export const getL2LedgerState = async (
  providers: L2Providers,
  contractAddress: ContractAddress,
): Promise<Uint8Array | null> => {
  assertIsContractAddress(contractAddress);
  logger.info('Checking contract ledger state...');
  const state = await providers.publicDataProvider
    .queryContractState(contractAddress)
    .then((contractState) => (contractState != null ? L2.ledger(contractState.data).stateRoot : null));
  logger.info(`Ledger state: ${state}`);
  return state;
};

export const l2ContractInstance: L2Contract = new L2.Contract(witnesses);

export const joinContract = async (providers: L2Providers, contractAddress: string): Promise<DeployedL2Contract> => {
  const l2Contract = await findDeployedContract(providers, {
    contractAddress,
    contract: l2ContractInstance,
    privateStateId: 'privateState',
    initialPrivateState: { privateState: 0 },
  });
  logger.info(`Joined contract at address: ${l2Contract.deployTxData.public.contractAddress}`);
  return l2Contract;
};

export const deploy = async (providers: L2Providers, privateState: L2PrivateState): Promise<DeployedL2Contract> => {
  logger.info('Deploying L2 contract...');
  const signers = new Signer().signersPub;
  const l2Contract = await deployContract(providers, {
    contract: l2ContractInstance,
    privateStateId: 'privateState',
    initialPrivateState: privateState,
    args: [signers, new Uint8Array(32)],
  });
  logger.info(`Deployed contract at address: ${l2Contract.deployTxData.public.contractAddress}`);
  fs.writeFileSync(
    'deployment.json',
    JSON.stringify({ contractAddress: l2Contract.deployTxData.public.contractAddress }),
  );
  return l2Contract;
};

export const updateStateRoot = async (
  l2Contract: DeployedL2Contract,
  newRoot: Uint8Array,
): Promise<FinalizedTxData> => {
  logger.info('Updating state root...');
  const signer = new Signer();
  const signature = signer.signStateRootUpdate(newRoot, 0);
  const finalizedTxData = await l2Contract.callTx.updateStateRoot(newRoot, signature);
  logger.info(`Transaction ${finalizedTxData.public.txId} added in block ${finalizedTxData.public.blockHeight}`);
  return finalizedTxData.public;
};

export const deposit = async (
  l2Contract: DeployedL2Contract,
  amount: bigint,
  l2Receiver: Uint8Array,
): Promise<bigint> => {
  logger.info('Depositing nativeToken to L2 contract...');
  const finalizedTxData = await l2Contract.callTx.deposit(
    {
      nonce: new Uint8Array(32),
      color: encodeContractAddress(nativeTokenRaw()),
      value: amount,
    },
    l2Receiver,
  );
  logger.info(
    `Deposit transaction ${finalizedTxData.public.txId} added in block ${finalizedTxData.public.blockHeight}`,
  );
  return finalizedTxData.private.result;
};

export const displayStateRoot = async (
  providers: L2Providers,
  l2Contract: DeployedL2Contract,
): Promise<{ stateRoot: Uint8Array | null; contractAddress: string }> => {
  const contractAddress = l2Contract.deployTxData.public.contractAddress;
  const stateRootValue = await getL2LedgerState(providers, contractAddress);
  if (stateRootValue === null) {
    logger.info(`There is no L2 contract deployed at ${contractAddress}.`);
  } else {
    logger.info(`Current state root value: ${Buffer.from(stateRootValue).toString('hex')}`);
  }
  return { contractAddress, stateRoot: stateRootValue };
};

export const withdraw = async (l2Contract: DeployedL2Contract, depositId: bigint): Promise<FinalizedTxData> => {
  logger.info(`Withdrawing depositId=${depositId}`);
  const withdrawInfo = { depositId };

  const signer = new Signer();
  const signature = signer.signWithdraw(withdrawInfo, 0);

  const finalizedTxData = await l2Contract.callTx.withdraw(withdrawInfo, signature);
  logger.info(
    `Withdraw transaction ${finalizedTxData.public.txId} added in block ${finalizedTxData.public.blockHeight}`,
  );
  return finalizedTxData.public;
};

export const createWalletAndMidnightProvider = async (wallet: Wallet): Promise<WalletProvider & MidnightProvider> => {
  const state = await Rx.firstValueFrom(wallet.state);
  return {
    getCoinPublicKey() {
      return state.coinPublicKey as any;
    },
    getEncryptionPublicKey() {
      return state.encryptionPublicKey as any;
    },
    async balanceTx(tx: UnprovenTransaction, newCoins?: ShieldedCoinInfo[], ttl?: Date): Promise<BalancedProvingRecipe> {
      // Get secret keys from the wallet state - in v3 this is managed internally
      // For now, we need to pass this through differently
      // The v3 wallet balances differently - it returns a ProvingRecipe
      throw new Error('balanceTx requires wallet secret keys - needs refactoring for v3 wallet SDK');
    },
    async submitTx(tx: any): Promise<TransactionId> {
      const result = await wallet.submitTransaction(tx);
      return result.txHash;
    },
  };
};

// Helper to check sync progress
const isSynced = (progress: { appliedIndex?: bigint; highestIndex?: bigint }) => {
  if (progress.appliedIndex === undefined || progress.highestIndex === undefined) {
    return false;
  }
  return progress.appliedIndex >= progress.highestIndex;
};

const formatProgress = (progress: { appliedIndex?: bigint; highestIndex?: bigint }) => {
  const applied = progress.appliedIndex ?? 0n;
  const highest = progress.highestIndex ?? 0n;
  return `${applied}/${highest}`;
};

export const waitForSync = async (wallet: Wallet): Promise<any> => {
  return await Rx.firstValueFrom(
    wallet.state.pipe(
      Rx.throttleTime(5_000),
      Rx.tap((state) => {
        const progress = state.progress;
        logger.info(
          `Waiting for sync. Progress: ${formatProgress(progress)}, transactions=${state.transactionHistory.length}`,
        );
      }),
      Rx.filter((state) => {
        // Let's allow progress only if wallet is synced fully
        return isSynced(state.progress);
      }),
    ),
  );
};

export const waitForSyncProgress = async (wallet: Wallet): Promise<any> => {
  return await Rx.firstValueFrom(
    wallet.state.pipe(
      Rx.throttleTime(5_000),
      Rx.tap((state) => {
        const progress = state.progress;
        logger.info(
          `Waiting for sync. Progress: ${formatProgress(progress)}, transactions=${state.transactionHistory.length}`,
        );
      }),
      Rx.filter((state) => {
        // Let's allow progress only if we have some progress
        return state.progress !== undefined;
      }),
    ),
  );
};

export const waitForFunds = (wallet: Wallet) =>
  Rx.firstValueFrom(
    wallet.state.pipe(
      Rx.throttleTime(10_000),
      Rx.tap((state) => {
        const progress = state.progress;
        logger.info(
          `Waiting for funds. Progress: ${formatProgress(progress)}, transactions=${state.transactionHistory.length}`,
        );
      }),
      Rx.filter((state) => {
        // Let's allow progress only if wallet is synced
        return isSynced(state.progress);
      }),
      Rx.map((s) => s.balances[nativeTokenRaw()] ?? 0n),
      Rx.filter((balance) => balance > 0n),
    ),
  );

export const buildWalletAndWaitForFunds = async (
  { indexer, indexerWS, node, proofServer }: Config,
  seed: string,
  filename: string,
): Promise<Wallet & Resource> => {
  // Convert hex seed to Uint8Array
  const seedBytes = new Uint8Array(
    seed.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) ?? []
  );
  
  // Get network ID from the global setting
  // Map midnight-js-network-id string to wallet-sdk-abstractions NetworkId
  const networkIdString = getNetworkId();
  const networkId = networkIdString as NetworkId.NetworkId;
  
  // Create wallet configuration following DefaultV1Configuration
  const walletConfig = {
    networkId,
    indexerClientConnection: {
      indexerHttpUrl: indexer,
      indexerWsUrl: indexerWS,
    },
    provingServerUrl: new URL(proofServer),
    relayURL: new URL(node),
  };
  
  // Create the shielded wallet
  const WalletClass = ShieldedWallet(walletConfig);
  const wallet = WalletClass.startWithShieldedSeed(seedBytes);
  
  // Start the wallet - secret keys are derived from seed internally
  // Note: startWithShieldedSeed derives the keys, so we pass undefined
  await wallet.start(undefined as any);

  const state = await Rx.firstValueFrom(wallet.state);
  logger.info(`Your wallet seed is: ${seed}`);
  logger.info(`Your wallet address is: ${state.address}`);
  let balance = state.balances[nativeTokenRaw()];
  if (balance === undefined || balance === 0n) {
    logger.info(`Your wallet balance is: 0`);
    logger.info(`Waiting to receive tokens...`);
    balance = await waitForFunds(wallet);
  }
  logger.info(`Your wallet balance is: ${balance}`);
  
  // Add close method for Resource interface
  const walletWithResource = wallet as Wallet & Resource;
  (walletWithResource as any).close = async () => {
    // v3 wallets use stop() instead of close()
    // wallet.stop() if available
  };
  
  return walletWithResource;
};

export const randomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  webcrypto.getRandomValues(bytes);
  return bytes;
};

export const buildFreshWallet = async (config: Config): Promise<Wallet & Resource> =>
  await buildWalletAndWaitForFunds(config, toHex(randomBytes(32)), '');

export const configureProviders = async (wallet: Wallet & Resource, config: Config) => {
  const walletAndMidnightProvider = await createWalletAndMidnightProvider(wallet);
  return {
    privateStateProvider: levelPrivateStateProvider<typeof L2PrivateStateId>({
      privateStateStoreName: contractConfig.privateStateStoreName,
    }),
    publicDataProvider: indexerPublicDataProvider(config.indexer, config.indexerWS),
    zkConfigProvider: new NodeZkConfigProvider<'updateStateRoot'>(contractConfig.zkConfigPath),
    proofProvider: httpClientProofProvider(config.proofServer),
    walletProvider: walletAndMidnightProvider,
    midnightProvider: walletAndMidnightProvider,
  };
};

export function setLogger(_logger: Logger) {
  logger = _logger;
}

export const streamToString = async (stream: fs.ReadStream): Promise<string> => {
  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk));
    stream.on('error', (err) => {
      reject(err);
    });
    stream.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
};

export const isAnotherChain = async (wallet: Wallet, offset: number) => {
  await waitForSyncProgress(wallet);
  // v3 doesn't expose offset in the same way
  // We'll skip this check for now
  return false;
};

export const saveState = async (wallet: Wallet, filename: string) => {
  const directoryPath = process.env.SYNC_CACHE;
  if (directoryPath !== undefined) {
    logger.info(`Saving state in ${directoryPath}/${filename}`);
    try {
      await fsAsync.mkdir(directoryPath, { recursive: true });
      const serializedState = await wallet.serializeState();
      const writer = fs.createWriteStream(`${directoryPath}/${filename}`);
      writer.write(serializedState);

      writer.on('finish', function () {
        logger.info(`File '${directoryPath}/${filename}' written successfully.`);
      });

      writer.on('error', function (err) {
        logger.error(err);
      });
      writer.end();
    } catch (e) {
      if (typeof e === 'string') {
        logger.warn(e);
      } else if (e instanceof Error) {
        logger.warn(e.message);
      }
    }
  } else {
    logger.info('Not saving cache as sync cache was not defined');
  }
};
