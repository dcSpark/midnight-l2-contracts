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
  setNetworkId,
  type CurvePoint
} from "@midnight-ntwrk/midnight-js-network-id";
import { describe, expect, it } from "vitest";
import { pureCircuits } from "../managed/L2/contract/index.cjs";
import { L2Simulator } from "./L2-simulator.js";
import { edwards } from '@noble/curves/abstract/edwards.js';
import { Field } from '@noble/curves/abstract/modular.js';
import * as runtime from "@midnight-ntwrk/compact-runtime";

setNetworkId(NetworkId.Undeployed);

// Define Jubjub parameters with Compact's Generator
const p = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;
const n = 6554484396890773809930967563523245729705921265872317281365359162392183254199n;
const Fp = Field(p);
const d = Fp.mul(Fp.neg(10240n), Fp.inv(10241n));

// Initialize custom Jubjub curve matching Compact's generator
const customJubjub = edwards({
  p,
  n,
  a: p - 1n, // a = -1
  d,
  Gx: 28336281903124990867587793011069573392383982287722241916350956173377953689573n,
  Gy: 39385640392217313770878525135509063452020585410343666726093009378539878503883n,
  h: 8n,
});

// Helper to verify signature using custom curve
function verifyWithNoble(pk: CurvePoint, sig: { r: CurvePoint, s: bigint }, challenge: bigint) {
  const G = customJubjub.BASE;
  const P = customJubjub.fromAffine(pk);
  const R = customJubjub.fromAffine(sig.r);
  
  // Calculate LHS: s * G
  const lhs = G.multiply(sig.s);
  
  // Calculate RHS: R + e * P
  const eTimesPk = P.multiply(challenge);
  const rhs = R.add(eTimesPk);
  
  return lhs.equals(rhs);
}

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
    expect(initialLedgerState.signers).toBeDefined();
    const initialPrivateState = simulator.getPrivateState();
    expect(initialPrivateState).toEqual({ privateState: 0 });
  });

  it("updates the state root correctly", () => {
    const simulator = new L2Simulator();
    const newRoot = new Uint8Array(32);
    newRoot.set([0x61, 0x62, 0x63]);
    
    const signature = simulator.sign(newRoot, 0); // Sign with signer 0
    
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
    const validSig = simulator.sign(newRoot, 0);
    const signature = { ...validSig, s: validSig.s + 1n };
    
    expect(() => simulator.updateStateRoot(newRoot, signature)).toThrow();
    expect(simulator.getLedger().stateRoot).toEqual(oldRoot);
  });

  it("verifies a valid signature", () => {
    const simulator = new L2Simulator();
    const msg = new Uint8Array(32).fill(1);
    const signature = simulator.sign(msg, 0);
    const pk = simulator.getPublicKey(0);
    
    expect(pureCircuits.verifySignature(pk, msg, signature)).toBe(true);
  });

  it("validates signatures against reference implementation (@noble/curves)", () => {
    const simulator = new L2Simulator();
    const msg = new Uint8Array(32).fill(1);
    const signature = simulator.sign(msg, 0);
    const pk = simulator.getPublicKey(0);

    // We need to re-derive the challenge 'e' exactly as the contract does
    const msgField = runtime.degradeToTransient(msg);
    
    const tupleType = {
      alignment: () => [
        { tag: 'atom' as const, value: { tag: 'field' as const } },
        { tag: 'atom' as const, value: { tag: 'field' as const } },
        { tag: 'atom' as const, value: { tag: 'field' as const } },
        { tag: 'atom' as const, value: { tag: 'field' as const } },
        { tag: 'atom' as const, value: { tag: 'field' as const } },
      ],
      toValue: (val: [CurvePoint, CurvePoint, bigint]) => [
        ...runtime.bigIntToValue(val[0].x),
        ...runtime.bigIntToValue(val[0].y),
        ...runtime.bigIntToValue(val[1].x),
        ...runtime.bigIntToValue(val[1].y),
        ...runtime.bigIntToValue(val[2])
      ],
      fromValue: (_: any) => { throw new Error("Not implemented"); }
    };

    const eRaw = runtime.transientHash(tupleType, [signature.r, pk, msgField]);
    const e = eRaw % n; // Reduce using scalar field order

    // Verify using custom noble curve
    expect(verifyWithNoble(pk, signature, e)).toBe(true);
  });

  it("rejects invalid signatures using reference implementation", () => {
    const simulator = new L2Simulator();
    const msg = new Uint8Array(32).fill(1);
    const signature = simulator.sign(msg, 0);
    const pk = simulator.getPublicKey(0);

    // Tamper with signature
    const invalidSignature = { ...signature, s: signature.s + 1n };

    // Re-derive challenge
    const msgField = runtime.degradeToTransient(msg);
    const tupleType = {
      alignment: () => [
        { tag: 'atom' as const, value: { tag: 'field' as const } },
        { tag: 'atom' as const, value: { tag: 'field' as const } },
        { tag: 'atom' as const, value: { tag: 'field' as const } },
        { tag: 'atom' as const, value: { tag: 'field' as const } },
        { tag: 'atom' as const, value: { tag: 'field' as const } },
      ],
      toValue: (val: [CurvePoint, CurvePoint, bigint]) => [
        ...runtime.bigIntToValue(val[0].x),
        ...runtime.bigIntToValue(val[0].y),
        ...runtime.bigIntToValue(val[1].x),
        ...runtime.bigIntToValue(val[1].y),
        ...runtime.bigIntToValue(val[2])
      ],
      fromValue: (_: any) => { throw new Error("Not implemented"); }
    };
    const eRaw = runtime.transientHash(tupleType, [signature.r, pk, msgField]);
    const e = eRaw % n;

    expect(verifyWithNoble(pk, invalidSignature, e)).toBe(false);
  });
});
