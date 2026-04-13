/**
 * state (decode) command: read and print Bridge state. No wallet required.
 */
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { Bridge } from 'bridge-contract/browser';
import { bech32m } from 'bech32';
import type { CliConfig } from '../cli-config.js';

const SOV_HRP = 'sov';

type L1ToL2DepositMessage = {
  sender: Uint8Array;
  recipient: Uint8Array;
  amount: bigint;
  nonce: bigint;
  gasLimit: bigint;
  dataHash: Uint8Array;
};

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** Encode L2 recipient bytes (28 or 32 from contract) as sov bech32m address. */
function recipientToBech32(bytes: Uint8Array): string {
  const len = Math.min(bytes.length, 28);
  const slice = bytes.subarray(0, len);
  const words = bech32m.toWords(Array.from(slice));
  return bech32m.encode(SOV_HRP, words);
}

function formatDeposit(deposit: L1ToL2DepositMessage) {
  return {
    sender: toHex(deposit.sender),
    recipient: recipientToBech32(deposit.recipient),
    amount: deposit.amount.toString(),
    nonce: deposit.nonce.toString(),
    gasLimit: deposit.gasLimit.toString(),
    dataHash: toHex(deposit.dataHash),
  };
}

export interface StateResult {
  contractAddress: string;
  network: string;
  initialized: boolean;
  nextCrossDomainMessageIndex: string;
  lastCommittedBatchIndex: string;
  lastCommittedBatchHash: string | null;
  lastFinalizedBatchIndex: string;
  lastFinalizedBatchHash: string | null;
  lastFinalizedStateRoot: string | null;
  withdrawRoot: string | null;
  rollingHashAtLatestIndex: string | null;
  deposits: Record<string, ReturnType<typeof formatDeposit>>;
}

export async function runState(
  cliConfig: CliConfig,
  opts: { json?: boolean; skipPrint?: boolean },
): Promise<StateResult> {
  const { config, contractAddress, networkLabel } = cliConfig;
  const provider = indexerPublicDataProvider(config.indexer, config.indexerWS);

  const contractState = await provider.queryContractState(contractAddress);
  if (!contractState) {
    throw new Error('No state found for contract');
  }

  const ledger = Bridge.ledger(contractState.data);
  const initialized = (ledger as { L1_initialized?: boolean }).L1_initialized ?? false;
  const lastFinalizedBatchIndex = ledger.L1_miscData.lastFinalizedBatchIndex;
  const lastCommittedBatchIndex = ledger.L1_miscData.lastCommittedBatchIndex;
  const nextIndex = ledger.L1_nextCrossDomainMessageIndex;

  const lastCommittedBatchHash = ledger.L1_lastCommittedBatchHash;
  const lastFinalizedBatchHash = ledger.L1_lastFinalizedBatchHash;
  const lastFinalizedStateRoot = ledger.L1_lastFinalizedStateRoot;
  const withdrawRoot = ledger.L1_withdrawRoots.member(lastFinalizedBatchIndex)
    ? ledger.L1_withdrawRoots.lookup(lastFinalizedBatchIndex)
    : null;

  let rollingHashAtNextIndex: Uint8Array | undefined;
  const rollingHashIndex = nextIndex > 0n ? nextIndex - 1n : 0n;
  if (ledger.L1_messageRollingHashes.member(rollingHashIndex)) {
    rollingHashAtNextIndex = ledger.L1_messageRollingHashes.lookup(rollingHashIndex);
  }

  const deposits: Record<string, ReturnType<typeof formatDeposit>> = {};
  for (let idx = 0n; idx < nextIndex; idx += 1n) {
    if (ledger.L1_l1ToL2Deposits.member(idx)) {
      const deposit = ledger.L1_l1ToL2Deposits.lookup(idx);
      deposits[idx.toString()] = formatDeposit(deposit);
    }
  }

  const result: StateResult = {
    contractAddress,
    network: networkLabel,
    initialized,
    nextCrossDomainMessageIndex: nextIndex.toString(),
    lastCommittedBatchIndex: lastCommittedBatchIndex.toString(),
    lastCommittedBatchHash: lastCommittedBatchHash ? toHex(lastCommittedBatchHash) : null,
    lastFinalizedBatchIndex: lastFinalizedBatchIndex.toString(),
    lastFinalizedBatchHash: lastFinalizedBatchHash ? toHex(lastFinalizedBatchHash) : null,
    lastFinalizedStateRoot: lastFinalizedStateRoot ? toHex(lastFinalizedStateRoot) : null,
    withdrawRoot: withdrawRoot ? toHex(withdrawRoot) : null,
    rollingHashAtLatestIndex: rollingHashAtNextIndex
      ? toHex(rollingHashAtNextIndex)
      : null,
    deposits,
  };

  if (opts.json && !opts.skipPrint) {
    console.log(JSON.stringify(result));
    return result;
  }
  if (opts.skipPrint) {
    return result;
  }

  console.log('Contract address:', contractAddress);
  console.log('Network:', networkLabel);
  console.log('Indexer:', config.indexer);
  console.log('Initialized:', initialized ? 'yes' : 'no');
  console.log('Next cross-domain message index:', nextIndex.toString());
  if (rollingHashAtNextIndex) {
    console.log('Rolling hash at latest index:', toHex(rollingHashAtNextIndex));
  }
  console.log(
    'Last committed batch:',
    'index',
    lastCommittedBatchIndex.toString(),
    'hash',
    lastCommittedBatchHash ? toHex(lastCommittedBatchHash) : '(none)',
  );
  console.log(
    'Last finalized batch:',
    'index',
    lastFinalizedBatchIndex.toString(),
    'hash',
    lastFinalizedBatchHash ? toHex(lastFinalizedBatchHash) : '(none)',
  );
  console.log('Withdraw root:', withdrawRoot ? toHex(withdrawRoot) : '(none)');
  console.log('---');
  console.log('L1 -> L2 deposits (0 → nextIndex-1):');
  const total = Object.keys(deposits).length;
  if (total === 0) {
    console.log('  (none)');
  } else {
    for (const [idx, dep] of Object.entries(deposits)) {
      console.log(`  ${idx}:`, dep);
    }
    console.log(`Total: ${total} entries.`);
  }
  return result;
}
