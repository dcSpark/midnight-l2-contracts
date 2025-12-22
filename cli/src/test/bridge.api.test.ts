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

/**
 * Bridge API Integration Tests
 * 
 * These tests require:
 * 1. Docker running for testcontainers
 * 2. ZK keys generated in the managed contract folders
 * 
 * To generate ZK keys, compile with zkir tool:
 *   cd contract && compact compile src/Bridge.compact src/managed/Bridge
 * 
 * The zkir tool generates keys/ folder with .prover and .verifier files.
 * Without these, the tests will fail with "ENOENT: no such file or directory".
 * 
 * For unit testing without network deployment, use contract/src/test/*.test.ts
 */

import { type Resource } from '@midnight-ntwrk/wallet';
import { type Wallet } from '@midnight-ntwrk/wallet-api';
import path from 'path';
import * as fs from 'fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as bridgeApi from '../bridge-api';
import { type BridgeProviders } from '../bridge-common-types';
import { currentDir, contractConfig } from '../config';
import { createLogger } from '../logger-utils';
import { TestEnvironment } from './commons';

const logDir = path.resolve(currentDir, '..', 'logs', 'tests', `bridge-${new Date().toISOString()}.log`);
const logger = await createLogger(logDir);

// Check if keys exist for the Bridge contract
const bridgeKeysPath = path.resolve(contractConfig.zkConfigPath, '..', 'Bridge', 'keys');
const hasZkKeys = fs.existsSync(bridgeKeysPath);

// Check if NetworkId is available in the runtime (version compatibility)
let hasNetworkId = false;
try {
  // @ts-expect-error - checking runtime compatibility
  const runtime = await import('@midnight-ntwrk/compact-runtime');
  hasNetworkId = runtime.NetworkId !== undefined;
} catch {
  hasNetworkId = false;
}

// Skip tests if ZK keys are not available or runtime is incompatible
const canRunTests = hasZkKeys && hasNetworkId;
const describeWithKeys = canRunTests ? describe : describe.skip;

describeWithKeys('Bridge API', () => {
  let testEnvironment: TestEnvironment;
  let wallet: Wallet & Resource;
  let providers: BridgeProviders;

  beforeAll(
    async () => {
      bridgeApi.setLogger(logger);
      testEnvironment = new TestEnvironment(logger);
      const testConfiguration = await testEnvironment.start();
      wallet = await testEnvironment.getWallet();
      providers = await bridgeApi.configureProviders(wallet, testConfiguration.dappConfig);
    },
    1000 * 60 * 45,
  );

  afterAll(async () => {
    await testEnvironment.saveWalletCache();
    await testEnvironment.shutdown();
  });

  it('should deploy the Bridge contract [@slow]', async () => {
    const bridgeContract = await bridgeApi.deploy(providers);
    expect(bridgeContract).not.toBeNull();
    
    // Verify initial state
    const lockedNIGHT = await bridgeApi.getLockedNIGHT(providers, bridgeContract);
    expect(lockedNIGHT).toBe(0n);
    
    const feeVault = await bridgeApi.getFeeVault(providers, bridgeContract);
    expect(feeVault).toBe(0n);
    
    const lastFinalized = await bridgeApi.lastFinalizedBatchIndex(providers, bridgeContract);
    expect(lastFinalized).toBe(0n);
    
    const lastCommitted = await bridgeApi.lastCommittedBatchIndex(providers, bridgeContract);
    expect(lastCommitted).toBe(0n);
  });

  it('should deposit NIGHT to L1 contract [@slow]', async () => {
    const bridgeContract = await bridgeApi.deploy(providers);
    expect(bridgeContract).not.toBeNull();

    const l2Recipient = new Uint8Array(32);
    l2Recipient.set([0x01, 0x02, 0x03]);
    
    const depositAmount = 1000000n; // 1 NIGHT (assuming 6 decimals)
    const gasLimit = 100000n;
    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    
    const result = await bridgeApi.depositNIGHT(
      bridgeContract,
      depositAmount,
      l2Recipient,
      gasLimit,
      timestamp
    );
    
    expect(result.txHash).toMatch(/[0-9a-f]{64}/);
    expect(result.blockHeight).toBeGreaterThan(0n);
    
    // Verify locked NIGHT increased
    const lockedNIGHT = await bridgeApi.getLockedNIGHT(providers, bridgeContract);
    expect(lockedNIGHT).toBe(depositAmount);
    
    // Verify queue index advanced
    const nextQueueIndex = await bridgeApi.getNextCrossDomainMessageIndex(providers, bridgeContract);
    expect(nextQueueIndex).toBe(2n); // Started at 1, now 2
  });

  it('should deposit NIGHT with fee [@slow]', async () => {
    const bridgeContract = await bridgeApi.deploy(providers);
    expect(bridgeContract).not.toBeNull();

    const l2Recipient = new Uint8Array(32);
    l2Recipient.set([0x01, 0x02, 0x03]);
    
    const depositAmount = 1000000n;
    const feeAmount = 10000n;
    const gasLimit = 100000n;
    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    
    const result = await bridgeApi.depositNIGHTWithFee(
      bridgeContract,
      depositAmount,
      feeAmount,
      l2Recipient,
      gasLimit,
      timestamp
    );
    
    expect(result.txHash).toMatch(/[0-9a-f]{64}/);
    expect(result.blockHeight).toBeGreaterThan(0n);
    
    // Verify locked NIGHT increased by deposit amount only
    const lockedNIGHT = await bridgeApi.getLockedNIGHT(providers, bridgeContract);
    expect(lockedNIGHT).toBe(depositAmount);
    
    // Verify fee vault increased
    const feeVault = await bridgeApi.getFeeVault(providers, bridgeContract);
    expect(feeVault).toBe(feeAmount);
  });

  it('should query L1 deposit details [@slow]', async () => {
    const bridgeContract = await bridgeApi.deploy(providers);
    
    const l2Recipient = new Uint8Array(32);
    l2Recipient.set([0xAA, 0xBB, 0xCC]);
    
    const depositAmount = 5000000n;
    const gasLimit = 150000n;
    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    
    await bridgeApi.depositNIGHT(
      bridgeContract,
      depositAmount,
      l2Recipient,
      gasLimit,
      timestamp
    );
    
    // Query the deposit at queue index 1
    const depositInfo = await bridgeApi.getL1ToL2Deposit(providers, bridgeContract, 1n);
    expect(depositInfo.amount).toBe(depositAmount);
    expect(depositInfo.gasLimit).toBe(gasLimit);
    expect(depositInfo.nonce).toBe(1n);
  });
});
