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

import {
  NetworkId,
  setNetworkId
} from "@midnight-ntwrk/midnight-js-network-id";
import { describe, expect, it } from "vitest";
import { L2Simulator } from "./L2-simulator.js";

setNetworkId(NetworkId.Undeployed);

describe("L2 smart contract", () => {
  it("generates initial ledger state deterministically", () => {
    const simulator0 = new L2Simulator();
    const simulator1 = new L2Simulator();
    expect(simulator0.getLedger()).toEqual(simulator1.getLedger());
  });

  it("properly initializes ledger state and private state", () => {
    const simulator = new L2Simulator();
    const initialLedgerState = simulator.getLedger();
    expect(initialLedgerState.stateRoot).toEqual(new Uint8Array(32));
    const initialPrivateState = simulator.getPrivateState();
    expect(initialPrivateState).toEqual({ privateState: 0 });
  });

  it("updates the state root correctly", () => {
    const simulator = new L2Simulator();
    const newRoot = new Uint8Array(32);
    newRoot.set([0x61, 0x62, 0x63]);
    const nextLedgerState = simulator.updateStateRoot(newRoot);
    expect(nextLedgerState.stateRoot).toEqual(newRoot);
    const nextPrivateState = simulator.getPrivateState();
    expect(nextPrivateState).toEqual({ privateState: 0 });
  });
});
