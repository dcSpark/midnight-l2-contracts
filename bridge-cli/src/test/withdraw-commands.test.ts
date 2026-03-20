import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Rx from 'rxjs';
import type { CliConfig } from '../cli-config.js';

const mockState = vi.hoisted(() => ({
  closeWallet: vi.fn(async () => undefined),
  setLogger: vi.fn(),
  buildWalletFromHexSeed: vi.fn(),
  buildWalletAndWaitForFunds: vi.fn(),
  configureProviders: vi.fn(),
  joinContract: vi.fn(),
  getBridgeLedger: vi.fn(),
  createLogger: vi.fn(async () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() })),
  ensurePendingBatch: vi.fn(async () => ({
    contractState: { data: {} },
    ledger: { L1_miscData: { lastFinalizedBatchIndex: 4n } },
    batchHash: new Uint8Array(32),
  })),
  buildBatchPublicData: vi.fn(async () => ({
    batchIndex: 5n,
  })),
  hashBatchPublicDataV1Full: vi.fn(() => new Uint8Array(32)),
  buildSignatureVector: vi.fn(() => [{}, {}, {}]),
  waitForBatchIndexUpdate: vi.fn(async () => ({ contractState: { data: {} }, ledger: {} })),
  deriveDefaultVerifierSet: vi.fn(() => [{ x: 1n, y: 2n }]),
  getVerifierSetFromEnvOrDefault: vi.fn(() => [
    { x: 0n, y: 1n },
    { x: 0n, y: 1n },
    { x: 0n, y: 1n },
  ]),
  bridgeLedgerValues: [] as bigint[],
  queryStateValues: [] as bigint[],
}));

vi.mock('../api.js', () => ({
  setLogger: mockState.setLogger,
  buildWalletFromHexSeed: mockState.buildWalletFromHexSeed,
  buildWalletAndWaitForFunds: mockState.buildWalletAndWaitForFunds,
  configureProviders: mockState.configureProviders,
  joinContract: mockState.joinContract,
  closeWallet: mockState.closeWallet,
  getBridgeLedger: mockState.getBridgeLedger,
}));

vi.mock('../logger.js', () => ({
  createLogger: mockState.createLogger,
}));

vi.mock('../batch-helpers.js', () => ({
  ensurePendingBatch: mockState.ensurePendingBatch,
  buildBatchPublicData: mockState.buildBatchPublicData,
  hashBatchPublicDataV1Full: mockState.hashBatchPublicDataV1Full,
  buildSignatureVector: mockState.buildSignatureVector,
  waitForBatchIndexUpdate: mockState.waitForBatchIndexUpdate,
  waitForVerifierSetOnChain: vi.fn(async () => undefined),
  deriveDefaultVerifierSet: mockState.deriveDefaultVerifierSet,
  getVerifierSetFromEnvOrDefault: mockState.getVerifierSetFromEnvOrDefault,
  DEFAULT_SIGNER_BITMAP: 7n,
}));

vi.mock('bridge-contract', () => ({
  computeMerkleRoot: vi.fn(() => new Uint8Array(32).fill(9)),
  computeWithdrawLeaf: vi.fn(() => new Uint8Array(32).fill(6)),
  generateMerkleProof: vi.fn(() => ({ proof: Array.from({ length: 16 }, () => new Uint8Array(32)) })),
  hashL2ToL1Withdraw: vi.fn(() => new Uint8Array(32).fill(5)),
}));

vi.mock('bridge-contract/browser', () => ({
  Bridge: {
    Contract: class {
      constructor(_witnesses: unknown) {}
    },
    ledger: vi.fn((data: { pending: bigint }) => ({
      L1_pendingWithdrawals: {
        member: () => true,
        lookup: () => data.pending,
      },
    })),
  },
  witnesses: {},
}));

vi.mock('@midnight-ntwrk/ledger-v8', () => ({
  unshieldedToken: () => ({ raw: 'night' }),
}));

vi.mock('@midnight-ntwrk/compact-runtime', () => ({
  encodeCoinPublicKey: vi.fn(() => new Uint8Array(32).fill(1)),
}));

vi.mock('@midnight-ntwrk/onchain-runtime-v3', () => ({
  encodeUserAddress: vi.fn(() => new Uint8Array(32).fill(2)),
  sampleUserAddress: vi.fn(() => ({ tag: 'user' })),
}));

import { runSetVerifierSet } from '../commands/set-verifier-set.js';
import { runRelayWithdrawNightWithProof } from '../commands/relay-withdraw-night-with-proof.js';
import { runTestWithdraw } from '../commands/test-withdraw.js';

const cliConfig: CliConfig = {
  config: { indexer: 'http://indexer', indexerWS: 'ws://indexer', node: 'ws://node', proofServer: 'http://proof' },
  contractAddress: 'a'.repeat(64),
  networkLabel: 'test',
} as unknown as CliConfig;

describe('withdraw command runners', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.bridgeLedgerValues = [10n, 14n];
    mockState.queryStateValues = [2n, 1n];

    const walletStates = [
      { isSynced: true, unshielded: { balances: { night: 1000n } } },
      { isSynced: true, unshielded: { balances: { night: 900n } } },
      { isSynced: true, unshielded: { balances: { night: 950n } } },
    ];
    let stateCall = 0;
    const walletContext = {
      wallet: {
        state: vi.fn(() => Rx.of(walletStates[stateCall++] ?? walletStates[walletStates.length - 1])),
      },
    };

    mockState.buildWalletFromHexSeed.mockResolvedValue(walletContext);
    mockState.buildWalletAndWaitForFunds.mockResolvedValue(walletContext);

    mockState.getBridgeLedger.mockImplementation(async () => {
      const lockedNight = mockState.bridgeLedgerValues.shift() ?? 14n;
      return {
        L1_lockedNIGHT: lockedNight,
        L1_executedL2ToL1Messages: { size: () => 0n },
      };
    });

    const callTx = {
      setVerifierSet: vi.fn(async () => ({ public: { txHash: 'set-hash' } })),
      depositNIGHTUnshielded: vi.fn(async () => ({ public: { txHash: 'deposit-hash' } })),
      finalizeBatch: vi.fn(async () => ({ public: { txHash: 'finalize-hash' } })),
      relayWithdrawNIGHTWithProof: vi.fn(async () => ({ public: { txHash: 'relay-hash' } })),
      claimL1WithdrawalUnshielded: vi.fn(async () => ({ public: { txHash: 'claim-hash' } })),
    };

    const providers = {
      walletProvider: {
        getCoinPublicKey: vi.fn(() => ({ x: 1n, y: 2n })),
      },
      publicDataProvider: {
        queryContractState: vi.fn(async () => ({
          data: { pending: mockState.queryStateValues.shift() ?? 1n },
        })),
      },
    };

    mockState.configureProviders.mockResolvedValue(providers);
    mockState.joinContract.mockResolvedValue({
      deployTxData: { public: { contractAddress: 'a'.repeat(64) } },
      callTx,
    });
  });

  it('submits set-verifier-set transaction', async () => {
    await runSetVerifierSet(cliConfig, {});
    const joined = await mockState.joinContract.mock.results[0].value;
    expect(joined.callTx.setVerifierSet).toHaveBeenCalledTimes(1);
    expect(mockState.closeWallet).toHaveBeenCalledTimes(1);
  });

  it('submits relay-withdraw-night-with-proof with parsed proof args', async () => {
    const siblings = JSON.stringify(Array.from({ length: 16 }, () => '11'.repeat(32)));
    const indexBits = JSON.stringify(Array.from({ length: 16 }, (_v, i) => i % 2 === 0));
    await runRelayWithdrawNightWithProof(cliConfig, {
      l2Sender: '00'.repeat(32),
      recipient: '22'.repeat(32),
      amount: '123',
      batchIndex: '7',
      nonce: '3',
      siblings,
      indexBits,
    });
    const joined = await mockState.joinContract.mock.results[0].value;
    expect(joined.callTx.relayWithdrawNIGHTWithProof).toHaveBeenCalledTimes(1);
    const relayCallArgs = joined.callTx.relayWithdrawNIGHTWithProof.mock.calls[0];
    expect(relayCallArgs[2]).toBe(123n);
    expect(relayCallArgs[3].batchIndex).toBe(7n);
    expect(relayCallArgs[3].nonce).toBe(3n);
    expect(relayCallArgs[3].indexBits).toHaveLength(16);
    expect(relayCallArgs[3].siblings).toHaveLength(16);
  });

  it('runs test-withdraw orchestration and submits all txs', async () => {
    await runTestWithdraw(cliConfig, {
      depositAmount: '4',
      waitAttempts: '2',
      waitDelayMs: '1',
    });
    const joined = await mockState.joinContract.mock.results[0].value;
    expect(joined.callTx.setVerifierSet).toHaveBeenCalledTimes(1);
    expect(joined.callTx.depositNIGHTUnshielded).toHaveBeenCalledTimes(1);
    expect(joined.callTx.finalizeBatch).toHaveBeenCalledTimes(1);
    expect(joined.callTx.relayWithdrawNIGHTWithProof).toHaveBeenCalledTimes(1);
    expect(joined.callTx.claimL1WithdrawalUnshielded).toHaveBeenCalledTimes(1);
  });
});
