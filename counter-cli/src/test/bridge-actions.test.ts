import path from 'path';
import * as api from '../api';
import { type BridgeProviders, type DeployedBridgeContract } from '../common-types';
import { currentDir } from '../config';
import { createLogger } from '../logger';
import { TestEnvironment } from './simulators/simulator';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as Rx from 'rxjs';
import * as ledger from '@midnight-ntwrk/ledger-v6';
import { encodeCoinPublicKey } from '@midnight-ntwrk/compact-runtime';
import 'dotenv/config';

let contractAddress = process.env.TEST_BRIDGE_ADDRESS;
const depositAmountEnv = process.env.TEST_DEPOSIT_AMOUNT_UNSHIELDED;
let deployedContract: DeployedBridgeContract | null = null;
let logDir: string;
const network = process.env.TEST_ENV || 'undeployed';
if (network === 'undeployed') {
  logDir = path.resolve(currentDir, '..', 'logs', 'test-bridge-actions-undeployed', `${new Date().toISOString()}.log`);
} else {
  logDir = path.resolve(currentDir, '..', 'logs', 'test-bridge-actions-preview', `${new Date().toISOString()}.log`);
}
const logger = await createLogger(logDir);

const describeConfigured = network === 'undeployed' || contractAddress ? describe : describe.skip;

const getUnshieldedBalance = async (wallet: api.WalletContext): Promise<bigint> => {
  const state = await Rx.firstValueFrom(wallet.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  return state.unshielded?.balances[ledger.nativeToken().raw] ?? 0n;
};

const waitForUnshieldedBalance = async (
  wallet: api.WalletContext,
  predicate: (balance: bigint) => boolean,
  timeoutMs = 120_000,
): Promise<bigint> =>
  await Rx.firstValueFrom(
    wallet.wallet.state().pipe(
      Rx.filter((state) => state.isSynced),
      Rx.map((state) => state.unshielded?.balances[ledger.nativeToken().raw] ?? 0n),
      Rx.filter(predicate),
      Rx.timeout({ first: timeoutMs }),
    ),
  );

const logFundingState = async (wallet: api.WalletContext) => {
  const state = await Rx.firstValueFrom(wallet.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  const unshielded = state.unshielded?.balances[ledger.nativeToken().raw] ?? 0n;
  const dust = state.dust?.walletBalance(new Date()) ?? 0n;
  const nightCoins = (state.unshielded?.availableCoins ?? []).filter(
    (coin) => coin.utxo.type === ledger.nativeToken().raw,
  );
  const registered = nightCoins.filter((coin) => coin.meta.registeredForDustGeneration).length;
  const unregistered = nightCoins.length - registered;

  logger.info({
    section: 'Funding State',
    unshieldedBalance: unshielded.toString(),
    dustBalance: dust.toString(),
    nightUtxos: nightCoins.length,
    registeredNightUtxos: registered,
    unregisteredNightUtxos: unregistered,
  });
};

const waitForLockedNIGHT = async (
  providers: BridgeProviders,
  address: string,
  expected: bigint,
  attempts = 20,
  delayMs = 3_000,
): Promise<bigint> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = await api.getBridgeQueryState(providers, address);
    if (state && state.lockedNIGHT >= expected) {
      return state.lockedNIGHT;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Timed out waiting for locked NIGHT to reach ${expected}`);
};

describeConfigured('Bridge actions', () => {
  let testEnvironment: TestEnvironment;
  let wallet: api.WalletContext;
  let providers: BridgeProviders;

  beforeAll(
    async () => {
      api.setLogger(logger);
      testEnvironment = new TestEnvironment(logger);
      const testConfiguration = await testEnvironment.start();
      logger.info(`Test configuration: ${JSON.stringify(testConfiguration)}`);
      wallet = await testEnvironment.getWallet();
      providers = await api.configureProviders(wallet, testConfiguration.dappConfig);
      await api.waitForSync(wallet.wallet);

      if (network === 'undeployed' && !contractAddress) {
        logger.info('TEST_BRIDGE_ADDRESS not set; deploying bridge contract for undeployed test');
        deployedContract = await api.deploy(providers, { privateState: 0 });
        contractAddress = deployedContract.deployTxData.public.contractAddress;
        logger.info(`Deployed bridge contract at ${contractAddress}`);
      }
    },
    1000 * 60 * 45,
  );

  afterAll(async () => {
    await testEnvironment.shutdown();
  });

  it('should deposit unshielded NIGHT and update balances [@slow]', async () => {
    if (!contractAddress) {
      throw new Error('TEST_BRIDGE_ADDRESS is required for preview tests');
    }
    if (!providers.walletProvider) {
      throw new Error('Wallet provider is not available');
    }

    await logFundingState(wallet);

    const bridgeContract = deployedContract ?? (await api.joinContract(providers, contractAddress));
    console.log('bridgeContract', bridgeContract.deployTxData.public.contractAddress);
    const stateBefore = await api.getBridgeQueryState(providers, bridgeContract.deployTxData.public.contractAddress);
    console.log('stateBefore', stateBefore);
    if (stateBefore === null) {
      throw new Error(`Bridge state not found for ${contractAddress}`);
    }

    const balanceBefore = await getUnshieldedBalance(wallet);

    let depositAmount: bigint;
    if (depositAmountEnv) {
      depositAmount = BigInt(depositAmountEnv);
    } else {
      const candidate = balanceBefore / 20n;
      depositAmount = candidate > 0n ? candidate : 1n;
    }

    if (depositAmount <= 0n) {
      throw new Error('Deposit amount must be greater than zero');
    }
    const coinPublicKey = providers.walletProvider.getCoinPublicKey();
    const l2Recipient = encodeCoinPublicKey(coinPublicKey);
    const gasLimit = 100_000n;
    const timestamp = 0n;

    const txData = await bridgeContract.callTx.depositNIGHTUnshielded(depositAmount, l2Recipient, gasLimit, timestamp);
    logger.info(`depositNIGHTUnshielded txHash: ${txData.public.txHash}`);

    const balanceAfter = await waitForUnshieldedBalance(wallet, (balance) => balance <= balanceBefore - depositAmount);
    expect(balanceAfter <= balanceBefore - depositAmount).toBe(true);

    const lockedAfter = await waitForLockedNIGHT(
      providers,
      bridgeContract.deployTxData.public.contractAddress,
      stateBefore.lockedNIGHT + depositAmount,
    );
    expect(lockedAfter).toBeGreaterThanOrEqual(stateBefore.lockedNIGHT + depositAmount);
  });
});
