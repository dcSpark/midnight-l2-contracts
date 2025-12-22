// This file is part of midnightntwrk/example-counter.
// Copyright (C) 2025 Midnight Foundation
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0 (the "License");
// You may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
import { WitnessContext } from "@midnight-ntwrk/compact-runtime";
import { Ledger } from "./managed/Bridge/contract/index.js";

// This is how we type an empty object.
export type BridgePrivateState = {
  privateState: number;
};

// Backwards compatibility alias
export type L2PrivateState = BridgePrivateState;

/**
 * Compute the 16-bit binary decomposition of an index.
 * Used by the Merkle tree to determine the path for incremental updates.
 * 
 * @param index - The index to decompose (must be < 2^16)
 * @returns Array of 16 booleans where bits[i] = true if bit i is set
 */
function computeIndexBits(index: bigint): boolean[] {
  const bits: boolean[] = [];
  for (let i = 0; i < 16; i++) {
    bits.push((index & (1n << BigInt(i))) !== 0n);
  }
  return bits;
}

/**
 * Compute the 3-bit binary decomposition of a bitmap.
 * Used for threshold signature verification (signerBitmap).
 * 
 * @param bitmap - The bitmap to decompose (must be < 8)
 * @returns Array of 3 booleans where bits[i] = true if bit i is set
 */
function computeBitmapBits(bitmap: bigint): boolean[] {
  const bits: boolean[] = [];
  for (let i = 0; i < 3; i++) {
    bits.push((bitmap & (1n << BigInt(i))) !== 0n);
  }
  return bits;
}

export const witnesses = {
  userPubKey(
    context: WitnessContext<Ledger, BridgePrivateState>
  ): [BridgePrivateState, { bytes: Uint8Array }] {
    return [context.privateState, { bytes: new Uint8Array(32) }];
  },

  /**
   * Parameterized witness: provides bit decomposition for a specific index.
   * 
   * The circuit passes the index it wants decomposed, and this witness returns
   * the 16-bit binary decomposition. The circuit then verifies this decomposition
   * matches the expected index.
   * 
   * @param context - The witness context with ledger and private state
   * @param index - The index to decompose (passed from the circuit)
   * @returns Tuple of [privateState, bits[16]]
   */
  indexBits(
    context: WitnessContext<Ledger, BridgePrivateState>,
    index: bigint
  ): [BridgePrivateState, boolean[]] {
    // Compute the 16-bit decomposition
    const bits = computeIndexBits(index);
    return [context.privateState, bits];
  },

  /**
   * Witness for signer bitmap decomposition in threshold signatures.
   * 
   * The L1Rollup module uses this to verify which signers participated
   * in a threshold signature without requiring bitwise operations in the circuit.
   * 
   * @param context - The witness context with ledger and private state
   * @param bitmap - The signer bitmap (passed from the circuit)
   * @returns Tuple of [privateState, bits[3]]
   */
  signerBitmapBits(
    context: WitnessContext<Ledger, BridgePrivateState>,
    bitmap: bigint
  ): [BridgePrivateState, boolean[]] {
    // Compute the 3-bit decomposition
    const bits = computeBitmapBits(bitmap);
    return [context.privateState, bits];
  }
};
