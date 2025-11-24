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

import * as runtime from "@midnight-ntwrk/compact-runtime";
import {
  type CircuitContext,
  constructorContext,
  type CurvePoint,
  degradeToTransient,
  ecMulGenerator,
  QueryContext,
  sampleContractAddress
} from "@midnight-ntwrk/compact-runtime";
import {
  Contract,
  type Ledger,
  ledger,
  type Signature
} from "../managed/L2/contract/index.cjs";
import { type L2PrivateState, witnesses } from "../witnesses.js";

export class L2Simulator {
  readonly contract: Contract<L2PrivateState>;
  circuitContext: CircuitContext<L2PrivateState>;
  private signers: { sk: bigint; pk: CurvePoint }[];

  constructor() {
    this.contract = new Contract<L2PrivateState>(witnesses);
    this.signers = [];
    const initialSigners: CurvePoint[] = [];

    // Generate 3 random key pairs (deterministically for tests)
    // Use small values to ensure they're well within the field
    for (let i = 1; i <= 3; i++) {
      const sk = BigInt(i + 100); // Simple small deterministic keys
      const pk = ecMulGenerator(sk);
      this.signers.push({ sk, pk });
      initialSigners.push(pk);
    }

    const {
      currentPrivateState,
      currentContractState,
      currentZswapLocalState
    } = this.contract.initialState(
      constructorContext({ privateState: 0 }, "0".repeat(64)),
      initialSigners,
      new Uint8Array(32)
    );
    this.circuitContext = {
      currentPrivateState,
      currentZswapLocalState,
      originalState: currentContractState,
      transactionContext: new QueryContext(
        currentContractState.data,
        sampleContractAddress()
      )
    };
  }

  public getLedger(): Ledger {
    return ledger(this.circuitContext.transactionContext.state);
  }

  public getPrivateState(): L2PrivateState {
    return this.circuitContext.currentPrivateState;
  }

  public getPublicKey(signerIndex: number): CurvePoint {
    if (signerIndex < 0 || signerIndex >= this.signers.length) {
      throw new Error("Invalid signer index");
    }
    return this.signers[signerIndex].pk;
  }

  public sign(val: Uint8Array, signerIndex: number): Signature {
    if (signerIndex < 0 || signerIndex >= this.signers.length) {
      throw new Error("Invalid signer index");
    }
    const { sk, pk } = this.signers[signerIndex];
    const msgField = degradeToTransient(val);

    // The embedded curve (Jubjub) scalar field order
    const JUBJUB_SCALAR_FIELD =
      6554484396890773809930967563523245729705921265872317281365359162392183254199n;

    // Create a CompactType for the tuple [CurvePoint, CurvePoint, Field]
    const tupleType = {
      alignment: () => [
        { tag: "atom" as const, value: { tag: "field" as const } },
        { tag: "atom" as const, value: { tag: "field" as const } },
        { tag: "atom" as const, value: { tag: "field" as const } },
        { tag: "atom" as const, value: { tag: "field" as const } },
        { tag: "atom" as const, value: { tag: "field" as const } }
      ],
      toValue: (val: [CurvePoint, CurvePoint, bigint]) => [
        ...runtime.bigIntToValue(val[0].x),
        ...runtime.bigIntToValue(val[0].y),
        ...runtime.bigIntToValue(val[1].x),
        ...runtime.bigIntToValue(val[1].y),
        ...runtime.bigIntToValue(val[2])
      ],
      fromValue: (_: any) => {
        throw new Error("Not implemented");
      }
    };

    // Grind for a valid e that fits in the Jubjub scalar field
    let k, r, e;
    let attempt = 0;
    while (true) {
      attempt++;
      k = BigInt((signerIndex + 1) * 12345 + attempt);
      r = ecMulGenerator(k);

      e = runtime.transientHash(tupleType, [r, pk, msgField]);

      if (e < JUBJUB_SCALAR_FIELD) {
        break;
      }
    }

    // For Schnorr: s = k + e*sk mod q
    const s = (k + e * sk) % JUBJUB_SCALAR_FIELD;

    return { r, s };
  }

  public updateStateRoot(val: Uint8Array, signature: Signature): Ledger {
    // Update the current context to be the result of executing the circuit.
    this.circuitContext = this.contract.impureCircuits.updateStateRoot(
      this.circuitContext,
      val,
      signature
    ).context;
    return ledger(this.circuitContext.transactionContext.state);
  }
}
