import { ContractState, encodeCoinPublicKey } from '@midnight-ntwrk/compact-runtime';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { encodeUserAddress, sampleUserAddress } from '@midnight-ntwrk/onchain-runtime-v3';
import { Buffer } from 'buffer';
import { computeMerkleRoot, computeWithdrawLeaf, generateMerkleProof, hashL2ToL1Withdraw } from 'bridge-contract';
import { Bridge, type BridgePrivateState, witnesses } from 'bridge-contract/browser';
import { createHash, randomBytes } from 'crypto';
import 'dotenv/config';
import path from 'path';
import * as Rx from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as api from '../api';
import { type BridgeL1ToL2DepositMessage } from '../api';
import { type BridgeProviders, type DeployedBridgeContract } from '../common-types';
import { currentDir } from '../config';
import { getVerifierSetFromEnvOrDefault } from '../batch-helpers.js';
import { signBytes32 as ledgerSignBytes32, verifyBytes32 as ledgerVerifyBytes32 } from '../ledger-signer.js';
import { createLogger } from '../logger';
import { TestEnvironment } from './simulators/simulator';

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

const ZERO_BYTES_32 = new Uint8Array(32);
const bridgeCircuitContract = new Bridge.Contract<BridgePrivateState>(witnesses);
const DEFAULT_VERIFIER_SECRET_KEYS = [101n, 102n, 103n] as const;
const DEFAULT_SIGNER_BITMAP = (1n << BigInt(DEFAULT_VERIFIER_SECRET_KEYS.length)) - 1n;
const SIGNATURE_NONCE = 0n;
const SIGNATURE_MAX_NONCE = 256n;
const WITHDRAW_TREE_DEPTH = 16;
type PublicDataProvider = NonNullable<BridgeProviders['publicDataProvider']>;
type Signature = Bridge.Signature;
type L1_BatchPublicDataV1Full = Bridge.L1_BatchPublicDataV1Full;

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
};

const isZeroBytes = (bytes: Uint8Array): boolean => bytes.every((value) => value === 0);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const resolveDepositAmount = (balance: bigint, divisor: bigint): bigint => {
  const candidate = balance / divisor;
  return candidate > 0n ? candidate : 1n;
};

const getUnshieldedBalance = async (wallet: api.WalletContext): Promise<bigint> => {
  const state = await Rx.firstValueFrom(wallet.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  return state.unshielded?.balances[ledger.unshieldedToken().raw] ?? 0n;
};

const waitForUnshieldedBalance = async (
  wallet: api.WalletContext,
  predicate: (_balance: bigint) => boolean,
  timeoutMs = 120_000,
): Promise<bigint> =>
  await Rx.firstValueFrom(
    wallet.wallet.state().pipe(
      Rx.filter((state) => state.isSynced),
      Rx.map((state) => state.unshielded?.balances[ledger.unshieldedToken().raw] ?? 0n),
      Rx.filter(predicate),
      Rx.timeout({ first: timeoutMs }),
    ),
  );

const logFundingState = async (wallet: api.WalletContext) => {
  const state = await Rx.firstValueFrom(wallet.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  const unshielded = state.unshielded?.balances[ledger.unshieldedToken().raw] ?? 0n;
  const dust = state.dust?.balance(new Date()) ?? 0n;
  const nightCoins = (state.unshielded?.availableCoins ?? []).filter(
    (coin) => coin.utxo.type === ledger.unshieldedToken().raw,
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
    const ledger = await api.getBridgeLedger(providers, address);
    if (ledger && ledger.L1_lockedNIGHT >= expected) {
      return ledger.L1_lockedNIGHT;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Timed out waiting for locked NIGHT to reach ${expected}`);
};

const waitForFeeVault = async (
  providers: BridgeProviders,
  address: string,
  expected: bigint,
  attempts = 20,
  delayMs = 3_000,
): Promise<bigint> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const ledger = await api.getBridgeLedger(providers, address);
    if (ledger && ledger.L1_feeVault >= expected) {
      return ledger.L1_feeVault;
    }
    await sleep(delayMs);
  }
  throw new Error(`Timed out waiting for fee vault to reach ${expected}`);
};

const waitForMessageRollingHash = async (
  providers: BridgeProviders,
  address: string,
  index: bigint,
  attempts = 20,
  delayMs = 3_000,
): Promise<Uint8Array> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const hash = await api.getMessageRollingHash(providers, address, index);
    if (hash && !isZeroBytes(hash)) {
      return hash;
    }
    await sleep(delayMs);
  }
  throw new Error(`Timed out waiting for rolling hash at index ${index}`);
};

const waitForL1ToL2Deposit = async (
  providers: BridgeProviders,
  address: string,
  queueIndex: bigint,
  attempts = 20,
  delayMs = 3_000,
): Promise<BridgeL1ToL2DepositMessage> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const message = await api.getL1ToL2Deposit(providers, address, queueIndex);
      if (message) {
        return message;
      }
    } catch {
      // Ignore transient errors while the indexer catches up.
    }
    await sleep(delayMs);
  }
  throw new Error(`Timed out waiting for deposit message at index ${queueIndex}`);
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
    const bridgeAddress = bridgeContract.deployTxData.public.contractAddress;
    logger.info({ section: 'BridgeContract', bridgeAddress });
    const ledgerBefore = await api.getBridgeLedger(providers, bridgeAddress);
    logger.info({ section: 'BridgeStateBefore', ledger: ledgerBefore });
    if (ledgerBefore === null) {
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
    const queueIndex = ledgerBefore.L1_nextCrossDomainMessageIndex;
    const coinPublicKey = providers.walletProvider.getCoinPublicKey();
    const l2Recipient = encodeCoinPublicKey(coinPublicKey);
    const gasLimit = 100_000n;
    const timestamp = 0n;

    const txData = await bridgeContract.callTx.depositNIGHTUnshielded(depositAmount, l2Recipient, gasLimit, timestamp);
    logger.info(`depositNIGHTUnshielded txHash: ${txData.public.txHash}`);

    const balanceAfter = await waitForUnshieldedBalance(wallet, (balance) => balance <= balanceBefore - depositAmount);
    expect(balanceAfter <= balanceBefore - depositAmount).toBe(true);

    const lockedAfter = await waitForLockedNIGHT(providers, bridgeAddress, ledgerBefore.L1_lockedNIGHT + depositAmount);
    expect(lockedAfter).toBeGreaterThanOrEqual(ledgerBefore.L1_lockedNIGHT + depositAmount);

    const depositMessage = await waitForL1ToL2Deposit(providers, bridgeAddress, queueIndex);
    expect(depositMessage.amount).toBe(depositAmount);
    expect(depositMessage.nonce).toBe(queueIndex);
    expect(depositMessage.gasLimit).toBe(gasLimit);
    expect(bytesEqual(depositMessage.recipient, l2Recipient)).toBe(true);
    expect(bytesEqual(depositMessage.sender, l2Recipient)).toBe(true);
    expect(bytesEqual(depositMessage.dataHash, ZERO_BYTES_32)).toBe(true);

    const rollingHash = await waitForMessageRollingHash(providers, bridgeAddress, queueIndex);
    expect(rollingHash.length).toBe(32);

    const storedTimestamp = await api.getMessageTimestamp(providers, bridgeAddress, queueIndex);
    if (storedTimestamp === null) {
      throw new Error('Failed to read message timestamp');
    }
    expect(storedTimestamp).toBe(timestamp);
  });

  it('should deposit unshielded NIGHT with fee and update fee vault [@slow]', async () => {
    if (!contractAddress) {
      throw new Error('TEST_BRIDGE_ADDRESS is required for preview tests');
    }
    if (!providers.walletProvider) {
      throw new Error('Wallet provider is not available');
    }

    const bridgeContract = deployedContract ?? (await api.joinContract(providers, contractAddress));
    const bridgeAddress = bridgeContract.deployTxData.public.contractAddress;
    const ledgerBefore = await api.getBridgeLedger(providers, bridgeAddress);
    if (ledgerBefore === null) {
      throw new Error(`Bridge state not found for ${contractAddress}`);
    }

    const balanceBefore = await getUnshieldedBalance(wallet);
    //const depositAmount = resolveDepositAmount(balanceBefore, 100n);
    const feeAmount = 1n;
    const spendableAfterFee = balanceBefore > feeAmount ? balanceBefore - feeAmount : 0n;
    if (spendableAfterFee <= 0n) {
      throw new Error('Not enough unshielded NIGHT to pay the bridge fee');
    }
    let depositAmount = resolveDepositAmount(spendableAfterFee, 100n);
    if (depositAmount > spendableAfterFee) {
      depositAmount = spendableAfterFee;
    }
    if (depositAmount <= 0n) {
      throw new Error('Deposit amount must be greater than zero after accounting for the fee');
    }
    const queueIndex = ledgerBefore.L1_nextCrossDomainMessageIndex;
    const coinPublicKey = providers.walletProvider.getCoinPublicKey();
    const l2Recipient = encodeCoinPublicKey(coinPublicKey);
    const gasLimit = 100_000n;
    const timestamp = 0n;

    const txData = await bridgeContract.callTx.depositNIGHTUnshieldedWithFee(
      depositAmount,
      feeAmount,
      l2Recipient,
      gasLimit,
      timestamp,
    );
    logger.info(`depositNIGHTUnshieldedWithFee txHash: ${txData.public.txHash}`);

    const balanceAfter = await waitForUnshieldedBalance(
      wallet,
      (balance) => balance <= balanceBefore - depositAmount - feeAmount,
    );
    expect(balanceAfter <= balanceBefore - depositAmount - feeAmount).toBe(true);

    const feeAfter = await waitForFeeVault(providers, bridgeAddress, ledgerBefore.L1_feeVault + feeAmount);
    expect(feeAfter).toBeGreaterThanOrEqual(ledgerBefore.L1_feeVault + feeAmount);

    const depositMessage = await waitForL1ToL2Deposit(providers, bridgeAddress, queueIndex);
    expect(depositMessage.amount).toBe(depositAmount);
    expect(depositMessage.nonce).toBe(queueIndex);
    expect(depositMessage.gasLimit).toBe(gasLimit);
    expect(bytesEqual(depositMessage.recipient, l2Recipient)).toBe(true);
    expect(bytesEqual(depositMessage.sender, l2Recipient)).toBe(true);
  });

  it('should enqueue sequential deposits with increasing indices [@slow]', async () => {
    if (!contractAddress) {
      throw new Error('TEST_BRIDGE_ADDRESS is required for preview tests');
    }
    if (!providers.walletProvider) {
      throw new Error('Wallet provider is not available');
    }

    const bridgeContract = deployedContract ?? (await api.joinContract(providers, contractAddress));
    const bridgeAddress = bridgeContract.deployTxData.public.contractAddress;
    const ledgerBefore = await api.getBridgeLedger(providers, bridgeAddress);
    if (ledgerBefore === null) {
      throw new Error(`Bridge state not found for ${contractAddress}`);
    }

    const balanceBefore = await getUnshieldedBalance(wallet);
    const firstAmount = resolveDepositAmount(balanceBefore, 80n);
    const secondAmount = resolveDepositAmount(balanceBefore, 120n);
    const firstIndex = ledgerBefore.L1_nextCrossDomainMessageIndex;
    const secondIndex = firstIndex + 1n;
    const coinPublicKey = providers.walletProvider.getCoinPublicKey();
    const l2Recipient = encodeCoinPublicKey(coinPublicKey);
    const gasLimit = 75_000n;
    const timestamp = 0n;

    const firstTx = await bridgeContract.callTx.depositNIGHTUnshielded(firstAmount, l2Recipient, gasLimit, timestamp);
    logger.info(`sequential deposit 1 txHash: ${firstTx.public.txHash}`);
    const message1 = await waitForL1ToL2Deposit(providers, bridgeAddress, firstIndex);

    const secondTx = await bridgeContract.callTx.depositNIGHTUnshielded(secondAmount, l2Recipient, gasLimit, timestamp);
    logger.info(`sequential deposit 2 txHash: ${secondTx.public.txHash}`);
    const message2 = await waitForL1ToL2Deposit(providers, bridgeAddress, secondIndex);

    expect(message1.nonce).toBe(firstIndex);
    expect(message2.nonce).toBe(secondIndex);

    const rolling1 = await waitForMessageRollingHash(providers, bridgeAddress, firstIndex);
    const rolling2 = await waitForMessageRollingHash(providers, bridgeAddress, secondIndex);
    expect(bytesEqual(rolling1, rolling2)).toBe(false);

    const ledgerAfter = await api.getBridgeLedger(providers, bridgeAddress);
    if (ledgerAfter === null) {
      throw new Error(`Bridge state not found for ${contractAddress}`);
    }
    expect(ledgerAfter.L1_nextCrossDomainMessageIndex).toBeGreaterThanOrEqual(firstIndex + 2n);
  });

  it('should relay and claim an unshielded withdrawal [@slow]', async () => {
    if (!contractAddress) {
      throw new Error('TEST_BRIDGE_ADDRESS is required for preview tests');
    }
    if (!providers.walletProvider) {
      throw new Error('Wallet provider is not available');
    }
    if (!providers.publicDataProvider) {
      throw new Error('Public data provider is not available');
    }

    const bridgeContract = deployedContract ?? (await api.joinContract(providers, contractAddress));
    const bridgeAddress = bridgeContract.deployTxData.public.contractAddress;
    await ensureDefaultVerifierSet(bridgeContract);

    const bridgeLedger = await api.getBridgeLedger(providers, bridgeAddress);
    if (bridgeLedger === null) {
      throw new Error(`Bridge state not found for ${contractAddress}`);
    }
    const balanceBefore = await getUnshieldedBalance(wallet);
    let depositAmount: bigint;
    if (depositAmountEnv) {
      depositAmount = BigInt(depositAmountEnv);
    } else {
      depositAmount = resolveDepositAmount(balanceBefore, 30n);
    }
    if (depositAmount < 4n) {
      depositAmount = 4n;
    }
    const withdrawAmount = depositAmount / 2n;
    if (withdrawAmount === 0n) {
      throw new Error('Withdraw amount must be greater than zero');
    }
    const claimAmount = withdrawAmount > 1n ? withdrawAmount - 1n : withdrawAmount;
    const expectedRemainder = withdrawAmount - claimAmount;

    const coinPublicKey = providers.walletProvider.getCoinPublicKey();
    if (!coinPublicKey) {
      throw new Error('Wallet provider coin key is not available');
    }
    const l2Recipient = encodeCoinPublicKey(coinPublicKey);
    const gasLimit = 120_000n;
    const timestamp = 0n;

    const depositTx = await bridgeContract.callTx.depositNIGHTUnshielded(
      depositAmount,
      l2Recipient,
      gasLimit,
      timestamp,
    );
    logger.info(`withdrawal test deposit txHash: ${depositTx.public.txHash}`);

    await waitForUnshieldedBalance(wallet, (balance) => balance <= balanceBefore - depositAmount);
    await waitForLockedNIGHT(providers, bridgeAddress, bridgeLedger.L1_lockedNIGHT + depositAmount);

    const withdrawNonce = bridgeLedger.L1_executedL2ToL1Messages.size();
    if (withdrawNonce >= 1n << BigInt(WITHDRAW_TREE_DEPTH)) {
      throw new Error('Withdraw nonce exceeds merkle tree depth capacity');
    }
    const recipientAddress = encodeUserAddress(sampleUserAddress());
    const withdrawMessageHash = hashL2ToL1Withdraw({
      sender: ZERO_BYTES_32,
      recipient: recipientAddress,
      amount: withdrawAmount,
      nonce: withdrawNonce,
    });
    const withdrawLeaf = computeWithdrawLeaf(withdrawMessageHash);
    const leafIndex = Number(withdrawNonce);
    const leaves = buildWithdrawLeaves(leafIndex, withdrawLeaf);
    const withdrawRoot = computeMerkleRoot(leaves, WITHDRAW_TREE_DEPTH);
    const proof = generateMerkleProof(leaves, leafIndex, WITHDRAW_TREE_DEPTH);
    const indexBits = computeIndexBits(BigInt(leafIndex), WITHDRAW_TREE_DEPTH);

    const batchInputs = await ensurePendingBatch({
      bridgeContract,
      contract: bridgeCircuitContract,
      contractAddress: bridgeAddress,
      publicDataProvider: providers.publicDataProvider,
    });

    const batchData = await buildBatchPublicData({
      contract: bridgeCircuitContract,
      contractAddress: bridgeAddress,
      contractState: batchInputs.contractState,
      ledger: batchInputs.ledger,
      batchHash: batchInputs.batchHash,
      withdrawRoot,
    });

    const digest = hashBatchPublicDataV1Full(batchData);
    const signatures = buildSignatureVector(digest);
    const finalizeTx = await bridgeContract.callTx.finalizeBatch(batchData, signatures, DEFAULT_SIGNER_BITMAP, 0n);
    logger.info(`finalizeBatch txHash: ${finalizeTx.public.txHash}`);

    const targetBatchIndex = batchInputs.ledger.L1_miscData.lastFinalizedBatchIndex + 1n;
    await waitForBatchIndexUpdate(
      providers.publicDataProvider,
      bridgeCircuitContract,
      bridgeAddress,
      (ledger) => ledger.L1_miscData.lastFinalizedBatchIndex >= targetBatchIndex,
      'lastFinalizedBatchIndex',
    );

    const relayTx = await bridgeContract.callTx.relayWithdrawNIGHTWithProof(
      ZERO_BYTES_32,
      recipientAddress,
      withdrawAmount,
      {
        batchIndex: batchData.batchIndex,
        nonce: withdrawNonce,
        indexBits,
        siblings: proof.proof,
      },
    );
    logger.info(`relayWithdrawNIGHTWithProof txHash: ${relayTx.public.txHash}`);

    const pendingAfterRelay = await waitForPendingWithdrawal(
      providers.publicDataProvider,
      bridgeAddress,
      recipientAddress,
      (value) => value >= withdrawAmount,
      'pending withdrawal after relay',
    );
    expect(pendingAfterRelay).toBeGreaterThanOrEqual(withdrawAmount);

    const balanceBeforeClaim = await getUnshieldedBalance(wallet);
    const claimTx = await bridgeContract.callTx.claimL1WithdrawalUnshielded(recipientAddress, claimAmount);
    logger.info(`claimL1WithdrawalUnshielded txHash: ${claimTx.public.txHash}`);
    await waitForUnshieldedBalance(wallet, (balance) => balance >= balanceBeforeClaim + claimAmount);

    const pendingAfterClaim = await waitForPendingWithdrawal(
      providers.publicDataProvider,
      bridgeAddress,
      recipientAddress,
      (value) => value === expectedRemainder,
      'pending withdrawal after claim',
    );
    expect(pendingAfterClaim).toBe(expectedRemainder);
  });
});

type EnsureBatchParams = {
  bridgeContract: DeployedBridgeContract;
  contract: Bridge.Contract<BridgePrivateState>;
  contractAddress: string;
  publicDataProvider: PublicDataProvider;
};

type EnsureBatchResult = {
  contractState: ContractState;
  ledger: Bridge.Ledger;
  batchHash: Uint8Array;
};

const ensureDefaultVerifierSet = async (bridgeContract: DeployedBridgeContract): Promise<void> => {
  await bridgeContract.callTx.setVerifierSet(getVerifierSetFromEnvOrDefault());
};

const getContractStateAndLedger = async (
  publicDataProvider: PublicDataProvider,
  contractAddress: string,
): Promise<{ contractState: ContractState; ledger: Bridge.Ledger }> => {
  const contractState = await publicDataProvider.queryContractState(contractAddress);
  if (!contractState) {
    throw new Error('No contract state available');
  }
  return { contractState, ledger: Bridge.ledger(contractState.data) };
};

const waitForBatchIndexUpdate = async (
  publicDataProvider: PublicDataProvider,
  _contract: Bridge.Contract<BridgePrivateState>,
  contractAddress: string,
  predicate: (ledger: Bridge.Ledger) => boolean,
  label: string,
  attempts = 20,
  delayMs = 3_000,
): Promise<{ contractState: ContractState; ledger: Bridge.Ledger }> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { contractState, ledger } = await getContractStateAndLedger(publicDataProvider, contractAddress);
    if (predicate(ledger)) {
      return { contractState, ledger };
    }
    await sleep(delayMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const ensurePendingBatch = async (params: EnsureBatchParams): Promise<EnsureBatchResult> => {
  const { contractState: initialContractState, ledger: initialLedger } = await getContractStateAndLedger(
    params.publicDataProvider,
    params.contractAddress,
  );
  const targetBatchIndex = initialLedger.L1_miscData.lastFinalizedBatchIndex + 1n;
  if (initialLedger.L1_miscData.lastCommittedBatchIndex >= targetBatchIndex) {
    const existingHash = await readCommittedBatch(
      params.contract,
      params.contractAddress,
      initialContractState,
      targetBatchIndex,
    );
    return { contractState: initialContractState, ledger: initialLedger, batchHash: existingHash };
  }

  const parentHash = await readCommittedBatch(
    params.contract,
    params.contractAddress,
    initialContractState,
    initialLedger.L1_miscData.lastCommittedBatchIndex,
  );
  const batchHash = randomBytes32();
  const tx = await params.bridgeContract.callTx.commitBatch(parentHash, batchHash);
  logger.info(`commitBatch txHash: ${tx.public.txHash}`);

  const updated = await waitForBatchIndexUpdate(
    params.publicDataProvider,
    params.contract,
    params.contractAddress,
    (ledger) => ledger.L1_miscData.lastCommittedBatchIndex >= targetBatchIndex,
    'lastCommittedBatchIndex',
  );
  logger.info(`ZZZZ ${updated.ledger.L1_miscData.lastCommittedBatchIndex}`);
  return { contractState: updated.contractState, ledger: updated.ledger, batchHash };
};

const readCommittedBatch = async (
  _contract: Bridge.Contract<BridgePrivateState>,
  _contractAddress: string,
  contractState: ContractState,
  index: bigint,
): Promise<Uint8Array> => {
  const ledgerState = Bridge.ledger(contractState.data);
  if (index === ledgerState.L1_miscData.lastCommittedBatchIndex) {
    return ledgerState.L1_lastCommittedBatchHash;
  }
  if (index === ledgerState.L1_miscData.lastFinalizedBatchIndex) {
    return ledgerState.L1_lastFinalizedBatchHash;
  }
  throw new Error(`Committed batch not found for index ${index}`);
};

const computeLastProcessedQueueIndex = (ledger: Bridge.Ledger): bigint => {
  if (ledger.L1_nextCrossDomainMessageIndex === 0n) {
    return 0n;
  }
  const candidate = ledger.L1_nextCrossDomainMessageIndex - 1n;
  if (ledger.L1_nextUnfinalizedQueueIndex === 0n) {
    return candidate;
  }
  const minimum = ledger.L1_nextUnfinalizedQueueIndex - 1n;
  return candidate > minimum ? candidate : minimum;
};

type BatchDataParams = {
  contract: Bridge.Contract<BridgePrivateState>;
  contractAddress: string;
  contractState: ContractState;
  ledger: Bridge.Ledger;
  batchHash: Uint8Array;
  withdrawRoot: Uint8Array;
};

const buildBatchPublicData = async (params: BatchDataParams): Promise<L1_BatchPublicDataV1Full> => {
  const prevBatchIndex = params.ledger.L1_miscData.lastFinalizedBatchIndex;
  const batchIndex = prevBatchIndex + 1n;
  const ledgerState = params.ledger;
  const prevBatchHash = ledgerState.L1_lastFinalizedBatchHash;
  const prevStateRoot = ledgerState.L1_lastFinalizedStateRoot;
  const lastProcessedQueueIndex = computeLastProcessedQueueIndex(params.ledger);
  const messageQueueHash = ledgerState.L1_messageRollingHashes.member(lastProcessedQueueIndex)
    ? ledgerState.L1_messageRollingHashes.lookup(lastProcessedQueueIndex)
    : ZERO_BYTES_32;

  return {
    version: 1n,
    layer2ChainId: 0n,
    rollupId: ZERO_BYTES_32,
    batchIndex,
    daStartHeight: 0n,
    daEndHeight: 0n,
    daCommitment: ZERO_BYTES_32,
    lastProcessedQueueIndex,
    messageQueueHash,
    prevStateRoot,
    prevBatchHash,
    postStateRoot: randomBytes32(),
    batchHash: params.batchHash,
    withdrawRoot: params.withdrawRoot,
  } satisfies L1_BatchPublicDataV1Full;
};

const buildSignatureVector = (digest: Uint8Array): Signature[] =>
  DEFAULT_VERIFIER_SECRET_KEYS.map((sk, index) => signWithNonceRetry(digest, sk, index, SIGNATURE_MAX_NONCE));

const signWithNonceRetry = (digest: Uint8Array, secretKey: bigint, signerIndex: number, _limit: bigint): Signature => {
  const base = SIGNATURE_NONCE === 0n ? 1n : SIGNATURE_NONCE;
  const nonce = base + BigInt(signerIndex);
  const signature = ledgerSignBytes32(digest, secretKey, nonce) as Signature;
  if (!ledgerVerifyBytes32(digest, signature)) {
    throw new Error(`Invalid signature for signer ${signerIndex}`);
  }
  return signature;
};

const strictPadBytes32Local = (value: string): Uint8Array => {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > 32) {
    throw new Error(`Value '${value}' exceeds 32 bytes`);
  }
  const out = new Uint8Array(32);
  out.set(bytes);
  return out;
};

const uToBytes32LELocal = (value: bigint): Uint8Array => {
  if (value < 0n) {
    throw new Error('Negative values not supported');
  }
  const out = new Uint8Array(32);
  let cursor = value;
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number(cursor & 0xffn);
    cursor >>= 8n;
  }
  if (cursor !== 0n) {
    throw new Error('Integer does not fit in 32 bytes');
  }
  return out;
};

const concatBytes32ChunksLocal = (chunks: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.length * 32);
  chunks.forEach((chunk, index) => {
    if (chunk.length !== 32) {
      throw new Error(`Chunk at position ${index} must be 32 bytes`);
    }
    out.set(chunk, index * 32);
  });
  return out;
};

const ensureBytes32Length = (value: Uint8Array, label: string): Uint8Array => {
  if (value.length !== 32) {
    throw new Error(`${label} must be 32 bytes`);
  }
  return value;
};

const sha256Local = (data: Uint8Array): Uint8Array => {
  const hash = createHash('sha256');
  hash.update(data);
  return new Uint8Array(hash.digest());
};

const BATCH_DOMAIN = strictPadBytes32Local('mdn:bpd:v1full');

const hashBatchPublicDataV1Full = (batch: L1_BatchPublicDataV1Full): Uint8Array => {
  const chunks = [
    BATCH_DOMAIN,
    uToBytes32LELocal(batch.version),
    uToBytes32LELocal(batch.layer2ChainId),
    ensureBytes32Length(batch.rollupId, 'rollupId'),
    uToBytes32LELocal(batch.batchIndex),
    uToBytes32LELocal(batch.daStartHeight),
    uToBytes32LELocal(batch.daEndHeight),
    ensureBytes32Length(batch.daCommitment, 'daCommitment'),
    uToBytes32LELocal(batch.lastProcessedQueueIndex),
    ensureBytes32Length(batch.messageQueueHash, 'messageQueueHash'),
    ensureBytes32Length(batch.prevStateRoot, 'prevStateRoot'),
    ensureBytes32Length(batch.prevBatchHash, 'prevBatchHash'),
    ensureBytes32Length(batch.postStateRoot, 'postStateRoot'),
    ensureBytes32Length(batch.batchHash, 'batchHash'),
    ensureBytes32Length(batch.withdrawRoot, 'withdrawRoot'),
  ];
  return sha256Local(concatBytes32ChunksLocal(chunks));
};

const randomBytes32 = (): Uint8Array => new Uint8Array(randomBytes(32));

const waitForPendingWithdrawal = async (
  publicDataProvider: PublicDataProvider,
  contractAddress: string,
  recipient: Uint8Array,
  predicate: (value: bigint) => boolean,
  label: string,
  attempts = 20,
  delayMs = 3_000,
): Promise<bigint> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const contractState = await publicDataProvider.queryContractState(contractAddress);
    if (!contractState) {
      throw new Error('No contract state available');
    }
    const ledgerState = Bridge.ledger(contractState.data);
    const pending = ledgerState.L1_pendingWithdrawals.member(recipient)
      ? ledgerState.L1_pendingWithdrawals.lookup(recipient)
      : 0n;
    if (predicate(pending)) {
      return pending;
    }
    await sleep(delayMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const computeIndexBits = (index: bigint, depth = WITHDRAW_TREE_DEPTH): boolean[] => {
  const bits: boolean[] = [];
  for (let i = 0; i < depth; i += 1) {
    bits.push((index & (1n << BigInt(i))) !== 0n);
  }
  return bits;
};

const buildWithdrawLeaves = (leafIndex: number, leaf: Uint8Array): Uint8Array[] => {
  const leaves: Uint8Array[] = Array.from({ length: leafIndex + 1 }, () => ZERO_BYTES_32);
  leaves[leafIndex] = leaf;
  return leaves;
};
