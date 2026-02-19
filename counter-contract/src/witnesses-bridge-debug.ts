import { WitnessContext } from "@midnight-ntwrk/compact-runtime";
import { Ledger } from "./managed/BridgeDebug/contract/index.js";

export type BridgeDebugPrivateState = {
  privateState: number;
};

/**
 * Compute the 3-bit binary decomposition of a bitmap.
 * Used for threshold signature verification (signerBitmap).
 */
function computeBitmapBits(bitmap: bigint): boolean[] {
  const bits: boolean[] = [];
  for (let i = 0; i < 3; i++) {
    bits.push((bitmap & (1n << BigInt(i))) !== 0n);
  }
  return bits;
}

export const bridgeDebugWitnesses = {
  userPubKey(
    context: WitnessContext<Ledger, BridgeDebugPrivateState>
  ): [BridgeDebugPrivateState, { bytes: Uint8Array }] {
    return [context.privateState, { bytes: new Uint8Array(32) }];
  },

  /**
   * Witness for signer bitmap decomposition in threshold signatures.
   */
  signerBitmapBits(
    context: WitnessContext<Ledger, BridgeDebugPrivateState>,
    bitmap: bigint
  ): [BridgeDebugPrivateState, boolean[]] {
    const bits = computeBitmapBits(bitmap);
    return [context.privateState, bits];
  }
};
