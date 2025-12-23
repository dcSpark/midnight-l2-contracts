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
  nativeToken,
  ZswapSecretKeys,
  type TransactionId,
} from '@midnight-ntwrk/ledger-v6';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import {
  type FinalizedTxData,
  type MidnightProvider,
  type WalletProvider,
} from '@midnight-ntwrk/midnight-js-types';
import { assertIsContractAddress, toHex } from '@midnight-ntwrk/midnight-js-utils';
import { ShieldedWallet, type CustomizedShieldedWallet, type ShieldedWalletState } from '@midnight-ntwrk/wallet-sdk-shielded';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { NetworkId } from '@midnight-ntwrk/wallet-sdk-abstractions';
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

// Type alias for ShieldedWallet
type Wallet = CustomizedShieldedWallet;
type Resource = { close(): Promise<void> };

// Helper to get native token raw type for balance lookups
const nativeTokenRaw = () => nativeToken().raw;

// Store wallet secret keys for balancing transactions
let walletSecretKeys: ZswapSecretKeys | undefined;

// HD Wallet key derivation helper
export const getShieldedSeed = (seed: string): Uint8Array => {
  const seedBuffer = Buffer.from(seed, 'hex');
  const hdWalletResult = HDWallet.fromSeed(seedBuffer);

  const { hdWallet } = hdWalletResult as {
    type: 'seedOk';
    hdWallet: HDWallet;
  };

  const derivationResult = hdWallet.selectAccount(0).selectRole(Roles.Zswap).deriveKeyAt(0);

  if (derivationResult.type === 'keyOutOfBounds') {
    throw new Error('Key derivation out of bounds');
  }

  return Buffer.from(derivationResult.key);
};

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
  const colorHex = nativeToken().raw;
  const colorBytes = new Uint8Array(
    colorHex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) ?? []
  );
  const finalizedTxData = await l2Contract.callTx.deposit(
    {
      nonce: new Uint8Array(32),
      color: colorBytes,
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
  const coinPublicKeyHex = state.address.coinPublicKeyString();
  const encryptionPublicKeyHex = state.address.encryptionPublicKeyString();
  
  logger.info(`Coin public key: ${coinPublicKeyHex}`);
  
  return {
    getCoinPublicKey() {
      return coinPublicKeyHex;
    },
    getEncryptionPublicKey() {
      return encryptionPublicKeyHex;
    },
    async balanceTx(tx: any, newCoins?: any[], _ttl?: Date): Promise<any> {
      if (!walletSecretKeys) {
        throw new Error('Wallet secret keys not set. Call buildWalletAndWaitForFunds first.');
      }
      return await wallet.balanceTransaction(walletSecretKeys, tx, newCoins ?? []);
    },
    async submitTx(tx: any): Promise<TransactionId> {
      const result = await wallet.submitTransaction(tx);
      return result.txHash;
    },
  };
};

// Helper to check sync progress
const isSynced = (state: ShieldedWalletState): boolean => {
  const progress = state.progress;
  if (!progress) return false;
  const applied = progress.appliedIndex ?? 0n;
  const highest = progress.highestRelevantIndex ?? 0n;
  return applied >= highest;
};

const formatProgress = (state: ShieldedWalletState): string => {
  const progress = state.progress;
  if (!progress) return 'undefined';
  return `${progress.appliedIndex ?? 0n}/${progress.highestRelevantIndex ?? 0n}`;
};

export const waitForSync = async (wallet: Wallet): Promise<ShieldedWalletState> => {
  logger.info('Waiting for wallet to sync...');
  // Use the built-in waitForSyncedState method
  return await wallet.waitForSyncedState();
};

export const waitForSyncProgress = async (wallet: Wallet): Promise<ShieldedWalletState> => {
  return await Rx.firstValueFrom(
    wallet.state.pipe(
      Rx.throttleTime(5_000),
      Rx.tap((state) => {
        logger.info(`Waiting for sync progress. Progress: ${formatProgress(state)}`);
      }),
      Rx.filter((state) => state.progress !== undefined),
    ),
  );
};

export const waitForFunds = async (wallet: Wallet): Promise<bigint> => {
  // First wait for sync
  await wallet.waitForSyncedState();
  
  return await Rx.firstValueFrom(
    wallet.state.pipe(
      Rx.throttleTime(10_000),
      Rx.tap((state) => {
        const balance = state.balances[nativeTokenRaw()] ?? 0n;
        logger.info(`Waiting for funds. Progress: ${formatProgress(state)}, balance: ${balance}`);
      }),
      Rx.filter((state) => isSynced(state)),
      Rx.map((state) => state.balances[nativeTokenRaw()] ?? 0n),
      Rx.filter((balance) => balance > 0n),
    ),
  );
};

export const buildWalletAndWaitForFunds = async (
  { indexer, indexerWS, node, proofServer }: Config,
  seed: string,
  _filename: string,
): Promise<Wallet & Resource> => {
  // Get network ID from the global setting
  const networkIdString = getNetworkId();
  const networkId = networkIdString as NetworkId.NetworkId;
  
  logger.info(`Building shielded wallet for seed: ${seed.substring(0, 8)}...`);
  logger.info(`Network ID: ${networkId}`);
  
  // Derive shielded key using HD wallet
  const shieldedSeed = getShieldedSeed(seed);
  
  // Create secret keys
  walletSecretKeys = ZswapSecretKeys.fromSeed(shieldedSeed);
  
  logger.info('Creating shielded wallet...');
  const walletConfig = {
    networkId,
    indexerClientConnection: {
      indexerHttpUrl: indexer,
      indexerWsUrl: indexerWS,
    },
    provingServerUrl: new URL(proofServer),
    relayURL: new URL(node),
  };
  const ShieldedWalletClass = ShieldedWallet(walletConfig);
  const wallet = ShieldedWalletClass.startWithShieldedSeed(shieldedSeed);
  
  // Start the wallet
  logger.info('Starting wallet sync...');
  await wallet.start(walletSecretKeys);
  logger.info('Wallet sync started');
  
  // Get initial state
  const state = await Rx.firstValueFrom(wallet.state);
  logger.info(`Your wallet seed is: ${seed}`);
  logger.info(`Your shielded address: ${state.address.coinPublicKeyString()}`);
  const balance = state.balances[nativeTokenRaw()] ?? 0n;
  logger.info(`Shielded balance: ${balance}`);
  
  // Add close method for Resource interface
  // The wallet has a stop() method from WalletLike, but TypeScript doesn't infer it
  const walletWithResource = wallet as Wallet & Resource;
  (walletWithResource as any).close = async () => {
    await (wallet as any).stop();
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
      walletProvider: walletAndMidnightProvider,
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

export const isAnotherChain = async (wallet: Wallet, _offset: number) => {
  await waitForSyncProgress(wallet);
  logger.info(`Chain check skipped`);
  return false;
};

export const saveState = async (wallet: Wallet, filename: string) => {
  const directoryPath = process.env.SYNC_CACHE;
  if (directoryPath !== undefined && filename) {
    logger.info(`Saving state in ${directoryPath}/${filename}`);
    try {
      await fsAsync.mkdir(directoryPath, { recursive: true });
      const serializedState = await wallet.serializeState();
      await fsAsync.writeFile(`${directoryPath}/${filename}`, serializedState, 'utf-8');
      logger.info(`State saved to ${directoryPath}/${filename}`);
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
