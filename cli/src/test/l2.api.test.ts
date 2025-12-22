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
 * L2 API Integration Tests
 * 
 * These tests require:
 * 1. Docker running for testcontainers
 * 2. ZK keys generated in the managed contract folders
 * 
 * To generate ZK keys, compile with zkir tool:
 *   cd contract && compact compile src/L2Simulation.compact src/managed/L2Simulation
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
import * as api from '../api';
import { type L2Providers } from '../common-types';
import { currentDir, contractConfig } from '../config';
import { createLogger } from '../logger-utils';
import { TestEnvironment } from './commons';

const logDir = path.resolve(currentDir, '..', 'logs', 'tests', `${new Date().toISOString()}.log`);
const logger = await createLogger(logDir);

// Check if keys exist for the L2 contract
const l2KeysPath = path.resolve(contractConfig.zkConfigPath, 'keys');
const hasZkKeys = fs.existsSync(l2KeysPath);

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

describeWithKeys('API', () => {
  let testEnvironment: TestEnvironment;
  let wallet: Wallet & Resource;
  let providers: L2Providers;

  beforeAll(
    async () => {
      api.setLogger(logger);
      testEnvironment = new TestEnvironment(logger);
      const testConfiguration = await testEnvironment.start();
      wallet = await testEnvironment.getWallet();
      providers = await api.configureProviders(wallet, testConfiguration.dappConfig);
    },
    1000 * 60 * 45,
  );

  afterAll(async () => {
    await testEnvironment.saveWalletCache();
    await testEnvironment.shutdown();
  });

  it('should deploy the contract and update the state root [@slow]', async () => {
    const l2Contract = await api.deploy(providers, { privateState: 0 });
    expect(l2Contract).not.toBeNull();

    const l2 = await api.displayStateRoot(providers, l2Contract);
    expect(l2.stateRoot).toEqual(new Uint8Array(32));

    await new Promise((resolve) => setTimeout(resolve, 2000));
    const newRoot = new Uint8Array(32);
    newRoot.set([0x61, 0x62, 0x63]);
    const response = await api.updateStateRoot(l2Contract, newRoot);
    expect(response.txHash).toMatch(/[0-9a-f]{64}/);
    expect(response.blockHeight).toBeGreaterThan(BigInt(0));

    const rootAfter = await api.displayStateRoot(providers, l2Contract);
    expect(rootAfter.stateRoot).toEqual(newRoot);
    expect(rootAfter.contractAddress).toEqual(l2.contractAddress);
  });
});
