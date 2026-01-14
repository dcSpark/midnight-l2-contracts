/* eslint-env node */
import { createCircuitContext } from '@midnight-ntwrk/compact-runtime';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { assertIsContractAddress } from '@midnight-ntwrk/midnight-js-utils';
import { Bridge, type BridgePrivateState, witnesses } from 'counter-contract/browser';
import { Console } from 'node:console';
import { stderr, stdout } from 'node:process';
import { WebSocket } from 'ws';
import { type Config, PreviewConfig, UndeployedConfig } from './config';

const console = new Console({ stdout, stderr });
globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

type L1ToL2DepositMessage = {
  sender: Uint8Array;
  recipient: Uint8Array;
  amount: bigint;
  nonce: bigint;
  gasLimit: bigint;
  dataHash: Uint8Array;
};

const DEFAULT_CONTRACT_ADDRESS =
  process.env.DEFAULT_BRIDGE_ADDRESS ?? 'fa8533250190a9d2b39686523e7b13e7dc30647a341f8163dceaec2cdc365f12';
const DEPOSIT_KEYS = parseKeys(process.env.DEPOSIT_KEYS);
const { config: baseConfig, label: configLabel } = resolveNetworkConfig();
const INDEXER_HTTP = process.env.INDEXER_HTTP ?? baseConfig.indexer;
const INDEXER_WS = process.env.INDEXER_WS ?? baseConfig.indexerWS;
const provider = indexerPublicDataProvider(INDEXER_HTTP, INDEXER_WS);
const ZERO_COIN_PUBLIC_KEY = '0'.repeat(64);
const defaultPrivateState: BridgePrivateState = { privateState: 0 };

type NetworkPreference = 'preview' | 'undeployed';

function resolveNetworkConfig(): { config: Config; label: string } {
  const envPreference = (process.env.MIDNIGHT_NETWORK ?? process.env.MIDNIGHT_ENV ?? '').trim().toLowerCase();
  if (envPreference.length === 0) {
    return { config: new PreviewConfig(), label: 'preview (default)' };
  }

  const map: Record<string, NetworkPreference> = {
    preview: 'preview',
    undeployed: 'undeployed',
    local: 'undeployed',
    standalone: 'undeployed',
    dev: 'undeployed',
  };

  const preference = map[envPreference];
  if (preference === 'undeployed') {
    return { config: new UndeployedConfig(), label: 'undeployed/local' };
  }
  if (preference === 'preview') {
    return { config: new PreviewConfig(), label: 'preview' };
  }

  console.warn(`Unknown MIDNIGHT_NETWORK value "${envPreference}". Falling back to preview settings.`);
  return { config: new PreviewConfig(), label: 'preview (fallback)' };
}

async function main() {
  const contractAddress = process.env.BRIDGE_CONTRACT_ADDRESS ?? DEFAULT_CONTRACT_ADDRESS;
  assertIsContractAddress(contractAddress);
  console.log('Querying Bridge contract at address:', contractAddress);
  console.log('Network preset:', configLabel);
  console.log('Indexer (HTTP/WS):', INDEXER_HTTP, INDEXER_WS);

  const contractState = await provider.queryContractState(contractAddress);
  if (!contractState) {
    throw new Error('No state found for contract');
  }

  const contract = new Bridge.Contract(witnesses);
  let circuitContext = createCircuitContext<BridgePrivateState>(
    contractAddress,
    ZERO_COIN_PUBLIC_KEY,
    contractState,
    defaultPrivateState,
  );

  const deposits = new Map<bigint, L1ToL2DepositMessage>();

  const lastFinalizedCall = contract.circuits.lastFinalizedBatchIndex(circuitContext);
  circuitContext = lastFinalizedCall.context as typeof circuitContext;
  const lastFinalizedBatchIndex = lastFinalizedCall.result;

  const lastCommittedCall = contract.circuits.lastCommittedBatchIndex(circuitContext);
  circuitContext = lastCommittedCall.context as typeof circuitContext;
  const lastCommittedBatchIndex = lastCommittedCall.result;

  const nextIndexCall = contract.circuits.getNextCrossDomainMessageIndex(circuitContext);
  circuitContext = nextIndexCall.context as typeof circuitContext;
  const nextIndex = nextIndexCall.result;
  console.log('Next cross-domain message index:', nextIndex.toString());
  console.log('Last committed batch index:', lastCommittedBatchIndex.toString());
  console.log('Last finalized batch index:', lastFinalizedBatchIndex.toString());

  const fetchAndCache = (queueIndex: bigint): L1ToL2DepositMessage | undefined => {
    if (deposits.has(queueIndex)) {
      return deposits.get(queueIndex);
    }
    try {
      const call = contract.circuits.getL1ToL2Deposit(circuitContext, queueIndex);
      circuitContext = call.context as typeof circuitContext;
      deposits.set(queueIndex, call.result);
      return call.result;
    } catch (error) {
      if (isUnknownQueueIndex(error)) {
        return undefined;
      }
      throw error;
    }
  };

  for (const key of DEPOSIT_KEYS) {
    const deposit = fetchAndCache(key);
    if (!deposit) {
      console.warn(`No deposit found for key ${key}`);
      continue;
    }
    console.log('---');
    console.log('Key', key.toString());
    console.dir(formatDeposit(deposit), { depth: null });
  }

  console.log('---');
  console.log('Iterating over all deposits (0 → nextIndex-1):');
  let total = 0;
  for (let idx = 0n; idx < nextIndex; idx += 1n) {
    const deposit = fetchAndCache(idx);
    if (!deposit) {
      continue;
    }
    console.log(`Key ${idx.toString()}:`, formatDeposit(deposit));
    total += 1;
  }
  if (total === 0) {
    console.log('Map is empty');
  } else {
    console.log(`Displayed ${total} entries (up to index ${nextIndex - 1n}).`);
  }
}

function isUnknownQueueIndex(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNKNOWN_QUEUE_INDEX');
}

function parseKeys(raw?: string | null): bigint[] {
  if (!raw || raw.trim().length === 0) {
    return [0n, 1n, 2n];
  }
  const entries = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const parsed: bigint[] = [];
  for (const value of entries) {
    try {
      parsed.push(BigInt(value));
    } catch (error) {
      console.warn(`Skipping invalid deposit key "${value}":`, error);
    }
  }
  return parsed.length > 0 ? parsed : [0n, 1n, 2n];
}

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

void main().catch((error) => {
  console.error('Failed to decode l1ToL2Deposits via circuit call:', error);
  process.exitCode = 1;
});
