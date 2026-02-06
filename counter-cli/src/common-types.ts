import type { ImpureCircuitId } from '@midnight-ntwrk/compact-js';
import type { DeployedContract, FoundContract } from '@midnight-ntwrk/midnight-js-contracts';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import { Bridge, type BridgePrivateState } from 'counter-contract/browser';

export type BridgeCircuits = ImpureCircuitId<Bridge.Contract<BridgePrivateState>>;

export const BridgePrivateStateId = 'bridgePrivateState';

export type BridgeProviders = MidnightProviders<BridgeCircuits, typeof BridgePrivateStateId, BridgePrivateState>;

export type BridgeContract = Bridge.Contract<BridgePrivateState>;

export type DeployedBridgeContract = DeployedContract<BridgeContract> | FoundContract<BridgeContract>;
