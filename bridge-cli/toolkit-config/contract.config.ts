/**
 * Bridge contract configuration for midnight-node-toolkit generate-intent circuit.
 *
 * Binds the compiled Bridge contract to its witnesses and file assets,
 * producing a ContractExecutable the toolkit can use to generate intents.
 *
 * Usage:
 *   midnight-node-toolkit generate-intent circuit \
 *     -c bridge-cli/toolkit-config/contract.config.ts \
 *     --toolkit-js-path <path-to-midnight-node/util/toolkit-js> \
 *     ...
 *
 * @module
 */

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { CompiledContract, ContractExecutable } from '@midnight-ntwrk/compact-js/effect';
import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import * as Bridge from '../../bridge-contract/dist/managed/Bridge/contract/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

type BridgePrivateState = { privateState: number };
type BridgeC = Bridge.Contract<BridgePrivateState>;
const BridgeC = Bridge.Contract;

function computeIndexBits(index: bigint): boolean[] {
  const bits: boolean[] = [];
  for (let i = 0; i < 16; i++) {
    bits.push((index & (1n << BigInt(i))) !== 0n);
  }
  return bits;
}

function computeBitmapBits(bitmap: bigint): boolean[] {
  const bits: boolean[] = [];
  for (let i = 0; i < 3; i++) {
    bits.push((bitmap & (1n << BigInt(i))) !== 0n);
  }
  return bits;
}

const witnesses: Bridge.Witnesses<BridgePrivateState> = {
  indexBits(
    context: WitnessContext<Bridge.Ledger, BridgePrivateState>,
    index: bigint,
  ): [BridgePrivateState, boolean[]] {
    return [context.privateState, computeIndexBits(index)];
  },
  signerBitmapBits(
    context: WitnessContext<Bridge.Ledger, BridgePrivateState>,
    bitmap: bigint,
  ): [BridgePrivateState, boolean[]] {
    return [context.privateState, computeBitmapBits(bitmap)];
  },
};

const createInitialPrivateState: () => BridgePrivateState = () => ({ privateState: 0 });

const managedDir = process.env['BRIDGE_MANAGED_DIR']
  ?? resolve(__dirname, '../../bridge-contract/dist/managed/Bridge');

export default {
  contractExecutable: CompiledContract.make<BridgeC>('Bridge', BridgeC).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(managedDir),
    ContractExecutable.make
  ),
  createInitialPrivateState,
  config: {
    keys: {
      coinPublic: '0'.repeat(64),
    },
    network: 'undeployed'
  }
};
