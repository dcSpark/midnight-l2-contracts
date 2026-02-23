/**
 * test-withdraw command: execute an end-to-end withdrawal workflow.
 */
import { Bridge, type BridgePrivateState, witnesses } from 'bridge-contract/browser';
import {
  computeMerkleRoot,
  computeWithdrawLeaf,
  generateMerkleProof,
  hashL2ToL1Withdraw,
} from 'bridge-contract';
import * as ledger from '@midnight-ntwrk/ledger-v7';
import { encodeCoinPublicKey } from '@midnight-ntwrk/compact-runtime';
import { encodeUserAddress, sampleUserAddress } from '@midnight-ntwrk/onchain-runtime-v2';
import * as Rx from 'rxjs';
import path from 'node:path';
import * as api from '../api.js';
import { type CliConfig, getWalletSeedFromEnv } from '../cli-config.js';
import { createLogger } from '../logger.js';
import { currentDir } from '../config.js';
import type { BridgeProviders } from '../common-types.js';
import type { ExecutorContext } from '../executor-context.js';
import {
  buildBatchPublicData,
  buildSignatureVector,
  DEFAULT_SIGNER_BITMAP,
  deriveDefaultVerifierSet,
  ensurePendingBatch,
  hashBatchPublicDataV1Full,
  waitForBatchIndexUpdate,
} from '../batch-helpers.js';

const WITHDRAW_TREE_DEPTH = 16;
const ZERO_BYTES_32 = new Uint8Array(32);
type PublicDataProvider = NonNullable<BridgeProviders['publicDataProvider']>;

export interface TestWithdrawOptions {
  depositAmount?: string;
  withdrawAmount?: string;
  claimAmount?: string;
  recipient?: string;
  l2Sender?: string;
  l2Recipient?: string;
  gasLimit?: string;
  timestamp?: string;
  signerBitmap?: string;
  finalizeTimestamp?: string;
  skipSetVerifierSet?: boolean;
  waitAttempts?: string;
  waitDelayMs?: string;
  json?: boolean;
}

export interface TestWithdrawResult {
  setVerifierSetTxHash: string | null;
  depositTxHash: string;
  finalizeTxHash: string;
  relayTxHash: string;
  claimTxHash: string;
  recipient: string;
  depositAmount: string;
  withdrawAmount: string;
  claimAmount: string;
  pendingAfterClaim: string;
  expectedRemainder: string;
  status: string;
}

function logProgress(message: string): void {
  console.error(`[test-withdraw] ${message}`);
}

function hexToBytes32(hex: string, label: string): Uint8Array {
  const s = hex.replace(/^0x/, '').trim();
  if (s.length !== 64 || !/^[0-9a-fA-F]+$/.test(s)) {
    throw new Error(`${label} must be 32 bytes (64 hex chars)`);
  }
  return new Uint8Array(Buffer.from(s, 'hex'));
}

function computeIndexBits(index: bigint, depth = WITHDRAW_TREE_DEPTH): boolean[] {
  const bits: boolean[] = [];
  for (let i = 0; i < depth; i += 1) {
    bits.push((index & (1n << BigInt(i))) !== 0n);
  }
  return bits;
}

function buildWithdrawLeaves(leafIndex: number, leaf: Uint8Array): Uint8Array<ArrayBuffer>[] {
  const leaves = Array.from({ length: leafIndex + 1 }, () => new Uint8Array(32));
  leaves[leafIndex] = new Uint8Array(leaf);
  return leaves;
}

function resolveDepositAmount(balance: bigint): bigint {
  const candidate = balance / 30n;
  return candidate > 0n ? candidate : 1n;
}

async function getUnshieldedBalance(wallet: api.WalletContext): Promise<bigint> {
  const state = await Rx.firstValueFrom(wallet.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  return state.unshielded?.balances[ledger.unshieldedToken().raw] ?? 0n;
}

async function waitForUnshieldedBalance(
  wallet: api.WalletContext,
  predicate: (_balance: bigint) => boolean,
  timeoutMs = 120_000,
): Promise<bigint> {
  return await Rx.firstValueFrom(
    wallet.wallet.state().pipe(
      Rx.filter((state) => state.isSynced),
      Rx.map((state) => state.unshielded?.balances[ledger.unshieldedToken().raw] ?? 0n),
      Rx.filter(predicate),
      Rx.timeout({ first: timeoutMs }),
    ),
  );
}

async function waitForLockedNIGHT(
  providers: BridgeProviders,
  contractAddress: string,
  expected: bigint,
  attempts: number,
  delayMs: number,
): Promise<bigint> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const currentLedger = await api.getBridgeLedger(providers, contractAddress);
    if (currentLedger && currentLedger.L1_lockedNIGHT >= expected) {
      return currentLedger.L1_lockedNIGHT;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Timed out waiting for locked NIGHT to reach ${expected.toString()}`);
}

async function waitForPendingWithdrawal(
  publicDataProvider: PublicDataProvider,
  contractAddress: string,
  recipient: Uint8Array,
  predicate: (value: bigint) => boolean,
  label: string,
  attempts: number,
  delayMs: number,
): Promise<bigint> {
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
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function runTestWithdraw(
  cliConfig: CliConfig,
  opts: TestWithdrawOptions,
  executorContext?: ExecutorContext,
): Promise<TestWithdrawResult> {
  const { config, contractAddress } = cliConfig;
  const gasLimit = opts.gasLimit !== undefined ? BigInt(opts.gasLimit) : 120_000n;
  const timestamp = opts.timestamp !== undefined ? BigInt(opts.timestamp) : 0n;
  const signerBitmap = opts.signerBitmap !== undefined ? BigInt(opts.signerBitmap) : DEFAULT_SIGNER_BITMAP;
  const finalizeTimestamp = opts.finalizeTimestamp !== undefined ? BigInt(opts.finalizeTimestamp) : 0n;
  const waitAttempts = opts.waitAttempts !== undefined ? Number.parseInt(opts.waitAttempts, 10) : 20;
  const waitDelayMs = opts.waitDelayMs !== undefined ? Number.parseInt(opts.waitDelayMs, 10) : 3_000;
  if (!Number.isInteger(waitAttempts) || waitAttempts <= 0) {
    throw new Error('--wait-attempts must be a positive integer');
  }
  if (!Number.isInteger(waitDelayMs) || waitDelayMs <= 0) {
    throw new Error('--wait-delay-ms must be a positive integer');
  }

  let walletContext: api.WalletContext | null = null;
  let providers = executorContext?.providers;
  let bridgeContract = executorContext?.bridgeContract;

  if (!providers || !bridgeContract) {
    const walletSeed = getWalletSeedFromEnv();
    const logPath = path.resolve(
      currentDir,
      '..',
      'logs',
      'bridge-cli',
      `${new Date().toISOString()}.log`,
    );
    const logger = await createLogger(logPath);
    api.setLogger(logger);
    const isHex =
      /^[0-9a-fA-F]{64}$/.test(walletSeed) ||
      /^0x[0-9a-fA-F]+$/.test(walletSeed);
    if (isHex) {
      walletContext = await api.buildWalletFromHexSeed(config, walletSeed.replace(/^0x/, ''));
    } else {
      walletContext = await api.buildWalletAndWaitForFunds(config, walletSeed);
    }
    providers = await api.configureProviders(walletContext, config);
    bridgeContract = await api.joinContract(providers, contractAddress);
  }

  if (!providers.walletProvider) {
    throw new Error('Wallet provider is not available');
  }
  if (!providers.publicDataProvider) {
    throw new Error('Public data provider is not available');
  }
  const publicDataProvider = providers.publicDataProvider;
  try {
    const bridgeAddress = bridgeContract.deployTxData.public.contractAddress;
    const circuitContract = new Bridge.Contract<BridgePrivateState>(witnesses);

    let setVerifierSetTxHash: string | null = null;
    if (!opts.skipSetVerifierSet) {
      logProgress('Sending setVerifierSet transaction...');
      const setVerifierTx = await bridgeContract.callTx.setVerifierSet(deriveDefaultVerifierSet());
      setVerifierSetTxHash = setVerifierTx.public.txHash;
      logProgress(`setVerifierSet submitted: ${setVerifierSetTxHash}`);
    }

    const bridgeLedger = await api.getBridgeLedger(providers, bridgeAddress);
    if (bridgeLedger === null) {
      throw new Error(`Bridge state not found for ${contractAddress}`);
    }
    const walletCtx = executorContext?.walletContext ?? walletContext!;
    const balanceBefore = await getUnshieldedBalance(walletCtx);
    let depositAmount = opts.depositAmount ? BigInt(opts.depositAmount) : resolveDepositAmount(balanceBefore);
    if (depositAmount < 4n) {
      depositAmount = 4n;
    }
    const withdrawAmount = opts.withdrawAmount ? BigInt(opts.withdrawAmount) : depositAmount / 2n;
    if (depositAmount <= 0n) {
      throw new Error('Deposit amount must be greater than zero');
    }
    if (withdrawAmount <= 0n) {
      throw new Error('Withdraw amount must be greater than zero');
    }
    const claimAmount =
      opts.claimAmount !== undefined
        ? BigInt(opts.claimAmount)
        : (withdrawAmount > 1n ? withdrawAmount - 1n : withdrawAmount);
    if (claimAmount <= 0n) {
      throw new Error('Claim amount must be greater than zero');
    }
    if (claimAmount > withdrawAmount) {
      throw new Error('Claim amount cannot exceed withdraw amount');
    }
    const expectedRemainder = withdrawAmount - claimAmount;

    const l2Recipient =
      opts.l2Recipient !== undefined
        ? hexToBytes32(opts.l2Recipient, '--l2-recipient')
        : (() => {
            const coinPublicKey = providers.walletProvider.getCoinPublicKey();
            if (!coinPublicKey) {
              throw new Error('Wallet provider coin key is not available');
            }
            return encodeCoinPublicKey(coinPublicKey);
          })();
    const recipientAddress =
      opts.recipient !== undefined
        ? hexToBytes32(opts.recipient, '--recipient')
        : encodeUserAddress(sampleUserAddress());
    const l2Sender = opts.l2Sender !== undefined ? hexToBytes32(opts.l2Sender, '--l2-sender') : ZERO_BYTES_32;

    logProgress('Sending depositNIGHTUnshielded transaction...');
    const depositTx = await bridgeContract.callTx.depositNIGHTUnshielded(
      depositAmount,
      l2Recipient,
      gasLimit,
      timestamp,
    );
    logProgress(`depositNIGHTUnshielded submitted: ${depositTx.public.txHash}`);
    // TODO: because of a Midnight bug the contract currently doesn't actually take the money
    // so we don't wait for balance change. Update when this is fixed
    //await waitForUnshieldedBalance(walletContext, (balance) => balance <= balanceBefore - depositAmount);
    logProgress('Waiting for locked NIGHT update after deposit...');
    await waitForLockedNIGHT(
      providers,
      bridgeAddress,
      bridgeLedger.L1_lockedNIGHT + depositAmount,
      waitAttempts,
      waitDelayMs,
    );

    const withdrawNonce = bridgeLedger.L1_executedL2ToL1Messages.size();
    if (withdrawNonce >= 1n << BigInt(WITHDRAW_TREE_DEPTH)) {
      throw new Error('Withdraw nonce exceeds merkle tree depth capacity');
    }
    const withdrawMessageHash = hashL2ToL1Withdraw({
      sender: l2Sender,
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
      contract: circuitContract,
      contractAddress: bridgeAddress,
      publicDataProvider,
    });
    const batchData = await buildBatchPublicData({
      contract: circuitContract,
      contractAddress: bridgeAddress,
      contractState: batchInputs.contractState,
      ledger: batchInputs.ledger,
      batchHash: batchInputs.batchHash,
      withdrawRoot,
    });
    const digest = hashBatchPublicDataV1Full(batchData);
    const signatures = buildSignatureVector(digest);
    logProgress('Sending finalizeBatch transaction...');
    const finalizeTx = await bridgeContract.callTx.finalizeBatch(
      batchData,
      signatures,
      signerBitmap,
      finalizeTimestamp,
    );
    logProgress(`finalizeBatch submitted: ${finalizeTx.public.txHash}`);

    const targetBatchIndex = batchInputs.ledger.L1_miscData.lastFinalizedBatchIndex + 1n;
    logProgress('Waiting for lastFinalizedBatchIndex update...');
    await waitForBatchIndexUpdate(
      publicDataProvider,
      circuitContract,
      bridgeAddress,
      (currentLedger) => currentLedger.L1_miscData.lastFinalizedBatchIndex >= targetBatchIndex,
      'lastFinalizedBatchIndex',
      waitAttempts,
      waitDelayMs,
    );

    logProgress('Sending relayWithdrawNIGHTWithProof transaction...');
    const relayTx = await bridgeContract.callTx.relayWithdrawNIGHTWithProof(
      l2Sender,
      recipientAddress,
      withdrawAmount,
      {
        batchIndex: batchData.batchIndex,
        nonce: withdrawNonce,
        indexBits,
        siblings: proof.proof,
      },
    );
    logProgress(`relayWithdrawNIGHTWithProof submitted: ${relayTx.public.txHash}`);

    logProgress('Waiting for pending withdrawal after relay...');
    await waitForPendingWithdrawal(
      publicDataProvider,
      bridgeAddress,
      recipientAddress,
      (value) => value >= withdrawAmount,
      'pending withdrawal after relay',
      waitAttempts,
      waitDelayMs,
    );

    //const balanceBeforeClaim = await getUnshieldedBalance(walletContext);
    logProgress('Sending claimL1WithdrawalUnshielded transaction...');
    const claimTx = await bridgeContract.callTx.claimL1WithdrawalUnshielded(recipientAddress, claimAmount);
    logProgress(`claimL1WithdrawalUnshielded submitted: ${claimTx.public.txHash}`);
    // TODO: uncomment when ledger-v8 is used
    // logProgress('Waiting for unshielded balance increase after claim...');
    // await waitForUnshieldedBalance(walletContext, (balance) => balance >= balanceBeforeClaim + claimAmount);

    logProgress('Waiting for pending withdrawal remainder after claim...');
    const pendingAfterClaim = await waitForPendingWithdrawal(
      publicDataProvider,
      bridgeAddress,
      recipientAddress,
      (value) => value === expectedRemainder,
      'pending withdrawal after claim',
      waitAttempts,
      waitDelayMs,
    );

    const result: TestWithdrawResult = {
      setVerifierSetTxHash,
      depositTxHash: depositTx.public.txHash,
      finalizeTxHash: finalizeTx.public.txHash,
      relayTxHash: relayTx.public.txHash,
      claimTxHash: claimTx.public.txHash,
      recipient: Buffer.from(recipientAddress).toString('hex'),
      depositAmount: depositAmount.toString(),
      withdrawAmount: withdrawAmount.toString(),
      claimAmount: claimAmount.toString(),
      pendingAfterClaim: pendingAfterClaim.toString(),
      expectedRemainder: expectedRemainder.toString(),
      status: 'completed',
    };
    if (!executorContext && opts.json) {
      console.log(JSON.stringify(result));
    } else if (!executorContext) {
      console.log('setVerifierSet txHash:', setVerifierSetTxHash ?? '(skipped)');
      console.log('depositNIGHTUnshielded txHash:', depositTx.public.txHash);
      console.log('finalizeBatch txHash:', finalizeTx.public.txHash);
      console.log('relayWithdrawNIGHTWithProof txHash:', relayTx.public.txHash);
      console.log('claimL1WithdrawalUnshielded txHash:', claimTx.public.txHash);
      console.log('pending withdrawal after claim:', pendingAfterClaim.toString());
    }
    return result;
  } finally {
    if (walletContext) {
      await api.closeWallet(walletContext);
    }
  }
}
