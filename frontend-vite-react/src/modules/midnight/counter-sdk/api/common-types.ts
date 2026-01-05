import type { Bridge, BridgePrivateState } from "counter-contract/browser";
import type { ImpureCircuitId, MidnightProviders } from "@midnight-ntwrk/midnight-js-types";
import type { DeployedContract, FoundContract } from "@midnight-ntwrk/midnight-js-contracts";

export type BridgeCircuits = ImpureCircuitId<
  Bridge.Contract<BridgePrivateState>
>;

export const BridgePrivateStateId = "bridgePrivateState";

export type BridgeProviders = MidnightProviders<
  BridgeCircuits,
  typeof BridgePrivateStateId,
  BridgePrivateState
>;

export type BridgeContract = Bridge.Contract<BridgePrivateState>;

export type DeployedBridgeContract =
  | DeployedContract<BridgeContract>
  | FoundContract<BridgeContract>;

export type UserAction = {
  refresh: string | undefined;
  depositNIGHT: string | undefined;
  withdrawNIGHT: string | undefined;
};

export type QueryState = {
  readonly nextCrossDomainMessageIndex?: bigint;
  readonly nextUnfinalizedQueueIndex?: bigint;
  readonly lockedNIGHT?: bigint;
  readonly feeVault?: bigint;
  readonly withdrawRoot?: Uint8Array;
  readonly withdrawMessageCount?: bigint;
  readonly pendingWithdrawal?: bigint;
  readonly lastDeposit?: Bridge.L1_DepositResult;
  readonly lastWithdraw?: Bridge.WithdrawNIGHTResult;
};

export type DerivedState = {
  readonly query: QueryState;
  readonly turns: UserAction;
};

export const emptyQueryState: QueryState = {
  nextCrossDomainMessageIndex: undefined,
  nextUnfinalizedQueueIndex: undefined,
  lockedNIGHT: undefined,
  feeVault: undefined,
  withdrawRoot: undefined,
  withdrawMessageCount: undefined,
  pendingWithdrawal: undefined,
  lastDeposit: undefined,
  lastWithdraw: undefined,
};

export const emptyState: DerivedState = {
  query: emptyQueryState,
  turns: {
    refresh: undefined,
    depositNIGHT: undefined,
    withdrawNIGHT: undefined,
  },
};

export const defaultPrivateState: BridgePrivateState = { privateState: 0 };
