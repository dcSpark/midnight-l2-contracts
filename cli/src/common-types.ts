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

import { L2, type L2PrivateState } from 'midnight-l2-contracts';
import type { ImpureCircuitId, MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import type { DeployedContract, FoundContract } from '@midnight-ntwrk/midnight-js-contracts';

export type L2Circuits = ImpureCircuitId<L2.Contract<L2PrivateState>>;

export const L2PrivateStateId = 'privateState';

export type L2Providers = MidnightProviders<L2Circuits, typeof L2PrivateStateId, L2PrivateState>;

export type L2Contract = L2.Contract<L2PrivateState>;

export type DeployedL2Contract = DeployedContract<L2Contract> | FoundContract<L2Contract>;
