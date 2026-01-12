import { describe, expect, it } from "vitest";
import {
  type CircuitContext,
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress
} from "@midnight-ntwrk/compact-runtime";
import {
  decodeRawTokenType,
  encodeUserAddress,
  sampleUserAddress
} from "@midnight-ntwrk/onchain-runtime-v1";
import {
  Contract,
  type L1_BatchPublicDataV1Full,
  type Signature
} from "../managed/Bridge/contract/index.js";
import { witnesses, type BridgePrivateState } from "../witnesses.js";
import {
  computeMerkleRoot,
  computeWithdrawLeaf,
  generateMerkleProof,
  hashL2ToL1Withdraw,
  zeroBytes32
} from "../protocol-types";

type BridgeContext = CircuitContext<BridgePrivateState>;
type EncodedCoinPublicKey = { bytes: Uint8Array };

const ZERO_BYTES_32 = zeroBytes32();
const ZERO_SIGNATURE: Signature = {
  pk: { x: 0n, y: 0n },
  r: { x: 0n, y: 0n },
  s: 0n
};

const nativeTokenType = () =>
  ({ tag: "unshielded", raw: decodeRawTokenType(ZERO_BYTES_32) } as const);

const mapFindByKey = <K, V>(map: Map<K, V>, key: K): V | undefined => {
  for (const [k, v] of map.entries()) {
    if (JSON.stringify(k) === JSON.stringify(key)) {
      return v;
    }
  }
  return undefined;
};

const computeIndexBits = (index: bigint): boolean[] => {
  const bits: boolean[] = [];
  for (let i = 0; i < 16; i++) {
    bits.push((index & (1n << BigInt(i))) !== 0n);
  }
  return bits;
};

const createBridgeHarness = () => {
  const contract = new Contract<BridgePrivateState>(witnesses);
  const impure = contract.impureCircuits as any;
  const constructorContext = createConstructorContext(
    { privateState: 0 },
    "0".repeat(64)
  );
  const verifierSet = [
    { x: 0n, y: 0n },
    { x: 0n, y: 0n },
    { x: 0n, y: 0n }
  ];
  const caller: EncodedCoinPublicKey = { bytes: new Uint8Array(32) };

  const initial = contract.initialState(
    constructorContext,
    ZERO_BYTES_32,
    1n,
    ZERO_BYTES_32,
    ZERO_BYTES_32,
    ZERO_BYTES_32,
    verifierSet,
    0n,
    caller.bytes,
    ZERO_BYTES_32
  );

  const context = createCircuitContext(
    sampleContractAddress(),
    caller,
    initial.currentContractState.data,
    initial.currentPrivateState
  );

  return { contract, impure, context, caller };
};

const resetContext = (
  context: BridgeContext,
  caller: EncodedCoinPublicKey
): BridgeContext =>
  createCircuitContext(
    context.currentQueryContext.address,
    caller,
    context.currentQueryContext.state,
    context.currentPrivateState
  );

describe("L1 unshielded bridge flow", () => {
  it("records unshielded deposit inputs and updates lockedNIGHT", () => {
    const { contract, impure, context, caller } = createBridgeHarness();
    const l2Recipient = new Uint8Array(32);
    const depositAmount = 1_234n;

    const depositResult = impure.depositNIGHTUnshielded(
      context,
      depositAmount,
      l2Recipient,
      100_000n,
      0n
    );

    expect(depositResult.result.queueIndex).toBe(1n);

    const tokenType = nativeTokenType();
    const inputs = depositResult.context.currentQueryContext.effects.unshieldedInputs;
    expect(mapFindByKey(inputs, tokenType)).toBe(depositAmount);

    const refreshed = resetContext(depositResult.context, caller);
    const lockedNIGHT = contract.impureCircuits.getLockedNIGHT(refreshed).result;
    expect(lockedNIGHT).toBe(depositAmount);
  });

  it("allows unshielded fee claims", () => {
    const { contract, impure, context, caller } = createBridgeHarness();
    const l2Recipient = new Uint8Array(32);

    const depositResult = impure.depositNIGHTUnshieldedWithFee(
      context,
      100n,
      7n,
      l2Recipient,
      50_000n,
      0n
    );

    const refreshed = resetContext(depositResult.context, caller);
    expect(contract.impureCircuits.getFeeVault(refreshed).result).toBe(7n);

    const userAddress = sampleUserAddress();
    const userBytes = encodeUserAddress(userAddress);

    const claimResult = impure.claimL1FeesUnshielded(
      refreshed,
      5n,
      userBytes
    );

    const tokenType = nativeTokenType();
    const outputs = claimResult.context.currentQueryContext.effects.unshieldedOutputs;
    expect(mapFindByKey(outputs, tokenType)).toBe(5n);

    const publicAddress = { tag: "user", address: userAddress } as const;
    const claimed = claimResult.context.currentQueryContext.effects.claimedUnshieldedSpends;
    expect(mapFindByKey(claimed, [tokenType, publicAddress])).toBe(5n);

    const afterClaim = resetContext(claimResult.context, caller);
    expect(contract.impureCircuits.getFeeVault(afterClaim).result).toBe(2n);
  });

  it("relays withdrawals and pays unshielded claims", () => {
    const { contract, impure, context, caller } = createBridgeHarness();
    const l2Recipient = new Uint8Array(32);

    const depositResult = impure.depositNIGHTUnshielded(
      context,
      1_000n,
      l2Recipient,
      100_000n,
      0n
    );

    let working = resetContext(depositResult.context, caller);

    const commitResult = contract.impureCircuits.commitBatch(
      working,
      ZERO_BYTES_32,
      ZERO_BYTES_32
    );
    working = resetContext(commitResult.context, caller);

    const userAddress = sampleUserAddress();
    const userBytes = encodeUserAddress(userAddress);
    const withdrawAmount = 400n;

    const messageHash = hashL2ToL1Withdraw({
      sender: ZERO_BYTES_32,
      recipient: userBytes,
      amount: withdrawAmount,
      nonce: 0n
    });
    const leaf = computeWithdrawLeaf(messageHash);
    const withdrawRoot = computeMerkleRoot([leaf], 16);
    const proof = generateMerkleProof([leaf], 0, 16);

    const batchPublicData: L1_BatchPublicDataV1Full = {
      version: 1n,
      layer2ChainId: 1n,
      rollupId: ZERO_BYTES_32,
      batchIndex: 1n,
      daStartHeight: 0n,
      daEndHeight: 0n,
      daCommitment: ZERO_BYTES_32,
      lastProcessedQueueIndex: 0n,
      messageQueueHash: ZERO_BYTES_32,
      prevStateRoot: ZERO_BYTES_32,
      prevBatchHash: ZERO_BYTES_32,
      postStateRoot: ZERO_BYTES_32,
      batchHash: ZERO_BYTES_32,
      withdrawRoot: withdrawRoot
    };

    const finalizeResult = contract.impureCircuits.finalizeBatch(
      working,
      batchPublicData,
      [ZERO_SIGNATURE, ZERO_SIGNATURE, ZERO_SIGNATURE],
      0n,
      0n
    );

    working = resetContext(finalizeResult.context, caller);

    const relayResult = contract.impureCircuits.relayWithdrawNIGHTWithProof(
      working,
      ZERO_BYTES_32,
      userBytes,
      withdrawAmount,
      {
        batchIndex: 1n,
        nonce: 0n,
        indexBits: computeIndexBits(0n),
        siblings: proof.proof
      }
    );

    const pending = contract.impureCircuits.getPendingWithdrawal(
      relayResult.context,
      userBytes
    ).result;
    expect(pending).toBe(withdrawAmount);

    const claimContext = resetContext(relayResult.context, caller);
    const claimResult = impure.claimL1WithdrawalUnshielded(
      claimContext,
      userBytes,
      250n
    );

    const tokenType = nativeTokenType();
    const outputs = claimResult.context.currentQueryContext.effects.unshieldedOutputs;
    expect(mapFindByKey(outputs, tokenType)).toBe(250n);

    const publicAddress = { tag: "user", address: userAddress } as const;
    const claimed = claimResult.context.currentQueryContext.effects.claimedUnshieldedSpends;
    expect(mapFindByKey(claimed, [tokenType, publicAddress])).toBe(250n);

    const afterClaim = resetContext(claimResult.context, caller);
    const pendingAfter = contract.impureCircuits.getPendingWithdrawal(
      afterClaim,
      userBytes
    ).result;
    expect(pendingAfter).toBe(150n);
  });
});
