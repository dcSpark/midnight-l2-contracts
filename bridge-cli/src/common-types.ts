import type { DeployedContract, FoundContract } from '@midnight-ntwrk/midnight-js-contracts';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import { Bridge, type BridgePrivateState } from 'bridge-contract/browser';

export type BridgeCircuits = keyof Bridge.Contract<BridgePrivateState>['provableCircuits'] & string;

export const BridgePrivateStateId = 'bridgePrivateState';

export type BridgeProviders = MidnightProviders<BridgeCircuits, typeof BridgePrivateStateId, BridgePrivateState>;

export type BridgeContract = Bridge.Contract<BridgePrivateState>;

export type DeployedBridgeContract = DeployedContract<BridgeContract> | FoundContract<BridgeContract>;
