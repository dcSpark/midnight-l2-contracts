import path from 'path';
import * as api from '../api';
import { type BridgeProviders } from '../common-types';
import { currentDir } from '../config';
import { createLogger } from '../logger';
import { TestEnvironment } from './simulators/simulator';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'dotenv/config';

let logDir: string;
const network = process.env.TEST_ENV || 'undeployed';
if (network === 'undeployed') {
  logDir = path.resolve(currentDir, '..', 'logs', 'test-undeployed', `${new Date().toISOString()}.log`);
} else {
  logDir = path.resolve(currentDir, '..', 'logs', 'test-preview', `${new Date().toISOString()}.log`);
}
const logger = await createLogger(logDir);

describe('API', () => {
  let testEnvironment: TestEnvironment;
  let wallet: api.WalletContext;
  let providers: BridgeProviders;

  beforeAll(
    async () => {
      logger.info('network', network);
      api.setLogger(logger);
      testEnvironment = new TestEnvironment(logger);
      const testConfiguration = await testEnvironment.start();
      logger.info(`Test configuration: ${JSON.stringify(testConfiguration)}`);
      wallet = await testEnvironment.getWallet();
      providers = await api.configureProviders(wallet, testConfiguration.dappConfig);
    },
    1000 * 60 * 45,
  );

  afterAll(async () => {
    await testEnvironment.shutdown();
  });

  it('should deploy the contract and read bridge state [@slow]', async () => {
    const bridgeContractDeployed = await api.deploy(providers, { privateState: 0 });
    expect(bridgeContractDeployed).not.toBeNull();

    const state = await api.displayBridgeState(providers, bridgeContractDeployed);
    if (state.state === null) {
      throw new Error('Expected bridge state to be available after deployment.');
    }
    expect(state.state.nextCrossDomainMessageIndex).toBe(1n);
    expect(state.state.nextUnfinalizedQueueIndex).toBe(1n);
    expect(state.state.lockedNIGHT).toBe(0n);
    expect(state.state.feeVault).toBe(0n);
    expect(state.state.withdrawMessageCount).toBe(0n);
  });

  it('Wallet Funcitonalities', async () => {
    logger.info({
      section: 'Wallet Context',
      dustSecretKey: wallet.dustSecretKey,
      sshieldedSecretKeys: wallet.shieldedSecretKeys,
      unshieldedKeystore: wallet.unshieldedKeystore,
    });
  });
});
