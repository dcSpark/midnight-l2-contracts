// This file is part of midnightntwrk/example-counter.
// Copyright (C) 2025 Midnight Foundation
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
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
import { pureCircuits } from "../managed/L2Simulation/contract/index.js";
import { L2Simulator } from "./L2Simulation-simulator.js";

setNetworkId(NetworkId.Undeployed);

describe("L2 smart contract", () => {
  it("generates initial ledger state deterministically", () => {
    const simulator0 = new L2Simulator();
    const simulator1 = new L2Simulator();

    function bigintReplacer(key: string, value: any) {
      return typeof value === "bigint" ? value.toString() : value;
    }

    expect(JSON.stringify(simulator0.getLedger(), bigintReplacer)).toEqual(
      JSON.stringify(simulator1.getLedger(), bigintReplacer)
    );
  });

  it("properly initializes ledger state and private state", () => {
    const simulator = new L2Simulator();
    const initialLedgerState = simulator.getLedger();
    expect(initialLedgerState.stateRoot).toEqual(new Uint8Array(32));
    expect(initialLedgerState.signers).toBeDefined();
    const initialPrivateState = simulator.getPrivateState();
    expect(initialPrivateState).toEqual({ privateState: 0 });
  });

  it("updates the state root correctly", () => {
    const simulator = new L2Simulator();
    const newRoot = new Uint8Array(32);
    newRoot.set([0x61, 0x62, 0x63]);

    const signature = simulator.signStateRootUpdate(newRoot, 0); // Sign with signer 0
    expect(pureCircuits.verifyStateRootSignature(newRoot, signature)).toBe(
      true
    );

    const nextLedgerState = simulator.updateStateRoot(newRoot, signature);
    expect(nextLedgerState.stateRoot).toEqual(newRoot);
    const nextPrivateState = simulator.getPrivateState();
    expect(nextPrivateState).toEqual({ privateState: 0 });
  });

  it("doesn't update state root when signature doesn't verify", () => {
    const simulator = new L2Simulator();
    const oldRoot = simulator.getLedger().stateRoot;
    const newRoot = new Uint8Array(32);
    newRoot.set([0x61, 0x62, 0x63]);

    // Create invalid signature (use valid structure but wrong value)
    const validSig = simulator.signStateRootUpdate(newRoot, 0);
    const signature = { ...validSig, s: validSig.s + 1n };

    expect(() => simulator.updateStateRoot(newRoot, signature)).toThrow();
    expect(simulator.getLedger().stateRoot).toEqual(oldRoot);
  });

  it("verifies a valid signature", () => {
    const simulator = new L2Simulator();
    const msg = new Uint8Array(32).fill(1);
    const signature = simulator.signStateRootUpdate(msg, 0);

    expect(pureCircuits.verifyStateRootSignature(msg, signature)).toBe(true);
  });
});
