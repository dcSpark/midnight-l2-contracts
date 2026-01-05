import { L2Simulation, type L2PrivateState } from 'counter-contract';
import type { ImpureCircuitId, MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import type { DeployedContract, FoundContract } from '@midnight-ntwrk/midnight-js-contracts';

export type L2Circuits = ImpureCircuitId<L2Simulation.Contract<L2PrivateState>>;

export const L2PrivateStateId = 'l2PrivateState';

export type L2Providers = MidnightProviders<L2Circuits, typeof L2PrivateStateId, L2PrivateState>;

export type L2Contract = L2Simulation.Contract<L2PrivateState>;

export type DeployedL2Contract = DeployedContract<L2Contract> | FoundContract<L2Contract>;

export type UserAction = {
  refresh: string | undefined;
};

export type DerivedState = {
  readonly signers: L2Simulation.Ledger['signers'];
  readonly stateRoot: L2Simulation.Ledger['stateRoot'];
};

export const emptyState: DerivedState = {
  signers: [],
  stateRoot: new Uint8Array(32),
};
