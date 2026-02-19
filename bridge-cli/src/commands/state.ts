/**
 * state (decode) command: read and print Bridge state. No wallet required.
 */
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { Bridge } from 'bridge-contract/browser';
import type { CliConfig } from '../cli-config.js';

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

function formatDeposit(deposit: L1ToL2DepositMessage) {
  return {
    sender: toHex(deposit.sender),
    recipient: toHex(deposit.recipient),
    amount: deposit.amount.toString(),
    nonce: deposit.nonce.toString(),
    gasLimit: deposit.gasLimit.toString(),
    dataHash: toHex(deposit.dataHash),
  };
}

export async function runState(
  cliConfig: CliConfig,
  opts: { json?: boolean },
): Promise<void> {
  const { config, contractAddress, networkLabel } = cliConfig;
  const provider = indexerPublicDataProvider(config.indexer, config.indexerWS);

  const contractState = await provider.queryContractState(contractAddress);
  if (!contractState) {
    throw new Error('No state found for contract');
  }

  const ledger = Bridge.ledger(contractState.data);
  const lastFinalizedBatchIndex = ledger.L1_miscData.lastFinalizedBatchIndex;
  const lastCommittedBatchIndex = ledger.L1_miscData.lastCommittedBatchIndex;
  const nextIndex = ledger.L1_nextCrossDomainMessageIndex;

  const lastCommittedBatchHash =
    ledger.L1_committedBatches.member(lastCommittedBatchIndex) ?
      ledger.L1_committedBatches.lookup(lastCommittedBatchIndex) :
      null;
  const lastFinalizedBatchHash =
    ledger.L1_committedBatches.member(lastFinalizedBatchIndex) ?
      ledger.L1_committedBatches.lookup(lastFinalizedBatchIndex) :
      null;

  let rollingHashAtNextIndex: Uint8Array | undefined;
  const rollingHashIndex = nextIndex > 0n ? nextIndex - 1n : 0n;
  if (ledger.L1_messageRollingHashes.member(rollingHashIndex)) {
    rollingHashAtNextIndex = ledger.L1_messageRollingHashes.lookup(rollingHashIndex);
  }

  if (opts.json) {
    const deposits: Record<string, ReturnType<typeof formatDeposit>> = {};
    for (let idx = 0n; idx < nextIndex; idx += 1n) {
      if (ledger.L1_l1ToL2Deposits.member(idx)) {
        const deposit = ledger.L1_l1ToL2Deposits.lookup(idx);
        deposits[idx.toString()] = formatDeposit(deposit);
      }
    }
    console.log(
      JSON.stringify({
        contractAddress,
        network: networkLabel,
        nextCrossDomainMessageIndex: nextIndex.toString(),
        lastCommittedBatchIndex: lastCommittedBatchIndex.toString(),
        lastCommittedBatchHash: lastCommittedBatchHash ? toHex(lastCommittedBatchHash) : null,
        lastFinalizedBatchIndex: lastFinalizedBatchIndex.toString(),
        lastFinalizedBatchHash: lastFinalizedBatchHash ? toHex(lastFinalizedBatchHash) : null,
        rollingHashAtLatestIndex: rollingHashAtNextIndex
          ? toHex(rollingHashAtNextIndex)
          : null,
        deposits,
      }),
    );
    return;
  }

  console.log('Contract address:', contractAddress);
  console.log('Network:', networkLabel);
  console.log('Indexer:', config.indexer);
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
  console.log('---');
  console.log('L1 -> L2 deposits (0 → nextIndex-1):');
  let total = 0;
  for (let idx = 0n; idx < nextIndex; idx += 1n) {
    if (!ledger.L1_l1ToL2Deposits.member(idx)) continue;
    const deposit = ledger.L1_l1ToL2Deposits.lookup(idx);
    console.log(`  ${idx.toString()}:`, formatDeposit(deposit));
    total += 1;
  }
  if (total === 0) {
    console.log('  (none)');
  } else {
    console.log(`Total: ${total} entries.`);
  }
}
