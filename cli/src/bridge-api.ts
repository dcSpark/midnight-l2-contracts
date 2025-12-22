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
import { type CustomizedShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { webcrypto } from 'crypto';
import { Bridge, witnesses } from 'midnight-l2-contracts';
import * as fs from 'node:fs';
import { type Logger } from 'pino';
import * as Rx from 'rxjs';
import { WebSocket } from 'ws';
import { type DeployedBridgeContract, type BridgeContract, BridgePrivateStateId, type BridgeProviders } from './bridge-common-types';
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

export const bridgeContractInstance: BridgeContract = new Bridge.Contract(witnesses);

export const joinContract = async (providers: BridgeProviders, contractAddress: string): Promise<DeployedBridgeContract> => {
  const bridgeContract = await findDeployedContract(providers, {
    contractAddress,
    contract: bridgeContractInstance,
    privateStateId: BridgePrivateStateId,
    initialPrivateState: { privateState: 0 },
  });
  logger.info(`Joined contract at address: ${bridgeContract.deployTxData.public.contractAddress}`);
  return bridgeContract;
};

export const deploy = async (providers: BridgeProviders): Promise<DeployedBridgeContract> => {
  logger.info('Deploying Bridge contract...');
  const signer = new Signer();
  
  // Generate owner address (32 bytes)
  const ownerBytes = new Uint8Array(32);
  webcrypto.getRandomValues(ownerBytes);
  
  // Layer 2 chain ID
  const layer2ChainId = 1n;
  
  // Rollup ID (32 bytes)
  const rollupId = new Uint8Array(32);
  rollupId.set([0x01, 0x02, 0x03, 0x04]); // Example rollup ID
  
  // Genesis state root (all zeros)
  const genesisStateRoot = new Uint8Array(32);
  
  // Genesis batch hash
  const genesisBatchHash = new Uint8Array(32);
  genesisBatchHash.set([0x01]); // Non-zero to distinguish from empty
  
  // Signature threshold
  const signatureThreshold = 2n; // 2 of 3
  
  // Initial sequencer (owner)
  const initialSequencer = ownerBytes;
  
  // Initial finalizer (empty = permissionless)
  const initialFinalizer = new Uint8Array(32);
  
  const bridgeContract = await deployContract(providers, {
    contract: bridgeContractInstance,
    privateStateId: BridgePrivateStateId,
    initialPrivateState: { privateState: 0 },
    args: [
      ownerBytes,
      layer2ChainId,
      rollupId,
      genesisStateRoot,
      genesisBatchHash,
      signer.signersPub,
      signatureThreshold,
      initialSequencer,
      initialFinalizer
    ],
  });
  
  logger.info(`Deployed contract at address: ${bridgeContract.deployTxData.public.contractAddress}`);
  fs.writeFileSync(
    'bridge-deployment.json',
    JSON.stringify({ contractAddress: bridgeContract.deployTxData.public.contractAddress }),
  );
  return bridgeContract;
};

export const depositNIGHT = async (
  bridgeContract: DeployedBridgeContract,
  amount: bigint,
  l2Recipient: Uint8Array,
  gasLimit: bigint,
  timestamp: bigint
): Promise<FinalizedTxData> => {
  logger.info(`Depositing ${amount} NIGHT to L1 contract...`);
  const finalizedTxData = await bridgeContract.callTx.depositNIGHT(
    {
      nonce: new Uint8Array(32),
      color: encodeContractAddress(nativeTokenRaw()),
      value: amount,
    },
    l2Recipient,
    gasLimit,
    timestamp
  );
  logger.info(
    `Deposit transaction ${finalizedTxData.public.txId} added in block ${finalizedTxData.public.blockHeight}`,
  );
  return finalizedTxData.public;
};

export const depositNIGHTWithFee = async (
  bridgeContract: DeployedBridgeContract,
  amount: bigint,
  feeAmount: bigint,
  l2Recipient: Uint8Array,
  gasLimit: bigint,
  timestamp: bigint
): Promise<FinalizedTxData> => {
  logger.info(`Depositing ${amount} NIGHT + ${feeAmount} fee to L1 contract...`);
  const finalizedTxData = await bridgeContract.callTx.depositNIGHTWithFee(
    {
      nonce: new Uint8Array(32),
      color: encodeContractAddress(nativeTokenRaw()),
      value: amount,
    },
    {
      nonce: new Uint8Array(32),
      color: encodeContractAddress(nativeTokenRaw()),
      value: feeAmount,
    },
    l2Recipient,
    gasLimit,
    timestamp
  );
  logger.info(
    `Deposit with fee transaction ${finalizedTxData.public.txId} added in block ${finalizedTxData.public.blockHeight}`,
  );
  return finalizedTxData.public;
};

// Query functions use circuit calls since the ledger state is mostly sealed
export const getLockedNIGHT = async (
  _providers: BridgeProviders,
  bridgeContract: DeployedBridgeContract,
): Promise<bigint> => {
  const result = await bridgeContract.callTx.getLockedNIGHT();
  return result.private.result;
};

export const getFeeVault = async (
  _providers: BridgeProviders,
  bridgeContract: DeployedBridgeContract,
): Promise<bigint> => {
  const result = await bridgeContract.callTx.getFeeVault();
  return result.private.result;
};

export const lastFinalizedBatchIndex = async (
  _providers: BridgeProviders,
  bridgeContract: DeployedBridgeContract,
): Promise<bigint> => {
  const result = await bridgeContract.callTx.lastFinalizedBatchIndex();
  return result.private.result;
};

export const lastCommittedBatchIndex = async (
  _providers: BridgeProviders,
  bridgeContract: DeployedBridgeContract,
): Promise<bigint> => {
  const result = await bridgeContract.callTx.lastCommittedBatchIndex();
  return result.private.result;
};

export const getNextCrossDomainMessageIndex = async (
  _providers: BridgeProviders,
  bridgeContract: DeployedBridgeContract,
): Promise<bigint> => {
  const result = await bridgeContract.callTx.getNextCrossDomainMessageIndex();
  return result.private.result;
};

export const getL1ToL2Deposit = async (
  _providers: BridgeProviders,
  bridgeContract: DeployedBridgeContract,
  queueIndex: bigint
): Promise<{ sender: Uint8Array; recipient: Uint8Array; amount: bigint; nonce: bigint; gasLimit: bigint; dataHash: Uint8Array }> => {
  const result = await bridgeContract.callTx.getL1ToL2Deposit(queueIndex);
  return result.private.result;
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
      throw new Error('balanceTx requires wallet secret keys - needs refactoring for v3 wallet SDK');
    },
    async submitTx(tx: any): Promise<TransactionId> {
      const result = await wallet.submitTransaction(tx);
      return result.txHash;
    },
  };
};

export const configureProviders = async (wallet: Wallet & Resource, config: Config): Promise<BridgeProviders> => {
  const walletAndMidnightProvider = await createWalletAndMidnightProvider(wallet);
  return {
    privateStateProvider: levelPrivateStateProvider<typeof BridgePrivateStateId>({
      privateStateStoreName: contractConfig.privateStateStoreName + '-bridge',
    }),
    publicDataProvider: indexerPublicDataProvider(config.indexer, config.indexerWS),
    zkConfigProvider: new NodeZkConfigProvider<'depositNIGHT'>(contractConfig.zkConfigPath),
    proofProvider: httpClientProofProvider(config.proofServer),
    walletProvider: walletAndMidnightProvider,
    midnightProvider: walletAndMidnightProvider,
  };
};

export function setLogger(_logger: Logger) {
  logger = _logger;
}
