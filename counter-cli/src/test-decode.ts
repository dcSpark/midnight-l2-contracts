import { ContractState, type AlignedValue, type StateValue } from '@midnight-ntwrk/compact-runtime';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { assertIsContractAddress } from '@midnight-ntwrk/midnight-js-utils';
import { WebSocket } from 'ws';
import { PreviewConfig } from './config';

// @ts-expect-error: apollo client expects a global WebSocket implementation in Node.
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

const previewConfig = new PreviewConfig();
const INDEXER_HTTP = process.env.INDEXER_HTTP ?? previewConfig.indexer;
const INDEXER_WS = process.env.INDEXER_WS ?? previewConfig.indexerWS;

const provider = indexerPublicDataProvider(INDEXER_HTTP, INDEXER_WS);

async function main() {
  const contractAddress = process.env.BRIDGE_CONTRACT_ADDRESS ?? DEFAULT_CONTRACT_ADDRESS;
  assertIsContractAddress(contractAddress);
  console.log('Querying Bridge contract at address:', contractAddress);
  console.log('Indexer (HTTP/WS):', INDEXER_HTTP, INDEXER_WS);

  const contractState = await provider.queryContractState(contractAddress);
  if (!contractState) {
    throw new Error('No state found for contract');
  }

  const deposits = decodeL1ToL2Deposits(contractState);
  console.log('Decoded l1ToL2Deposits map size:', deposits.size);

  for (const key of DEPOSIT_KEYS) {
    const deposit = deposits.get(key);
    if (!deposit) {
      console.warn(`No deposit found for key ${key}`);
      continue;
    }
    console.log('---');
    console.log('Key', key.toString());
    console.dir(formatDeposit(deposit), { depth: null });
  }

  console.log('---');
  console.log('Iterating over all deposits:');
  let total = 0;
  for (const [key, deposit] of deposits) {
    console.log(`Key ${key.toString()}:`, formatDeposit(deposit));
    total += 1;
  }
  if (total === 0) {
    console.log('Map is empty');
  } else {
    console.log(`Displayed ${total} entries.`);
  }
}

function decodeL1ToL2Deposits(contractState: ContractState): Map<bigint, L1ToL2DepositMessage> {
  const map = findDepositMap(contractState.data.state);
  if (!map) {
    throw new Error('Unable to locate l1ToL2Deposits map in contract state');
  }
  return map;
}

function findDepositMap(state: StateValue): Map<bigint, L1ToL2DepositMessage> | undefined {
  const queue: StateValue[] = [state];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    if (current.type() === 'map') {
      const decoded = decodeIfDepositMap(current);
      if (decoded) {
        return decoded;
      }
    }
    if (current.type() === 'array') {
      const children = current.asArray();
      if (children) {
        queue.push(...children);
      }
    }
  }
  return undefined;
}

function decodeIfDepositMap(stateValue: StateValue): Map<bigint, L1ToL2DepositMessage> | undefined {
  const stateMap = stateValue.asMap();
  if (!stateMap) {
    return undefined;
  }
  const keys = stateMap.keys();
  if (keys.length === 0) {
    return undefined;
  }

  const entries = [] as { key: bigint; value: L1ToL2DepositMessage }[];
  for (const key of keys) {
    const valueState = stateMap.get(key);
    if (!valueState || valueState.type() !== 'cell') {
      return undefined;
    }
    const cell = valueState.asCell();
    if (!cell || !looksLikeDepositCell(cell)) {
      return undefined;
    }
    entries.push({ key: decodeUintKey(key), value: decodeDepositCell(cell) });
  }

  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const decoded = new Map<bigint, L1ToL2DepositMessage>();
  for (const entry of entries) {
    decoded.set(entry.key, entry.value);
  }
  return decoded;
}

function decodeUintKey(key: AlignedValue): bigint {
  const [chunk] = key.value;
  return decodeUintLE(chunk);
}

function decodeDepositCell(cell: AlignedValue): L1ToL2DepositMessage {
  const [sender, recipient, amount, nonce, gasLimit, dataHash] = cell.value;
  return {
    sender: normalizeBytes(sender, 32),
    recipient: normalizeBytes(recipient, 32),
    amount: decodeUintLE(amount),
    nonce: decodeUintLE(nonce),
    gasLimit: decodeUintLE(gasLimit),
    dataHash: normalizeBytes(dataHash, 32),
  };
}

function looksLikeDepositCell(cell: AlignedValue): boolean {
  if (cell.value.length !== 6) {
    return false;
  }
  const [sender, recipient, amount, nonce, gasLimit] = cell.value;
  return (
    isBytesLike(sender, 32) &&
    isBytesLike(recipient, 32) &&
    isUintChunk(amount, 16) &&
    isUintChunk(nonce, 8) &&
    isUintChunk(gasLimit, 8)
  );
}

function normalizeBytes(chunk: Uint8Array | undefined, expectedLength: number): Uint8Array {
  if (!chunk || chunk.length === 0) {
    return new Uint8Array(expectedLength);
  }
  if (chunk.length === expectedLength) {
    return new Uint8Array(chunk);
  }
  if (chunk.length > expectedLength) {
    return chunk.slice(chunk.length - expectedLength);
  }
  const padded = new Uint8Array(expectedLength);
  padded.set(chunk, expectedLength - chunk.length);
  return padded;
}

function decodeUintLE(chunk?: Uint8Array): bigint {
  if (!chunk || chunk.length === 0) {
    return 0n;
  }
  let result = 0n;
  for (let i = 0; i < chunk.length; i += 1) {
    result += BigInt(chunk[i]) << (8n * BigInt(i));
  }
  return result;
}

function isBytesLike(chunk: Uint8Array | undefined, expectedLength: number): boolean {
  return !chunk || chunk.length === 0 || chunk.length === expectedLength;
}

function isUintChunk(chunk: Uint8Array | undefined, maxLength: number): boolean {
  return !chunk || chunk.length <= maxLength;
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
  console.error('Failed to decode l1ToL2Deposits:', error);
  process.exitCode = 1;
});
