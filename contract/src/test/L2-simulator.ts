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

// import * as runtime from "@midnight-ntwrk/compact-runtime";
import {
  type CircuitContext,
  constructorContext,
  type CurvePoint,
  QueryContext,
  sampleContractAddress
} from "@midnight-ntwrk/compact-runtime";
import {
  Contract,
  type Ledger,
  ledger,
  pureCircuits,
  type Signature
} from "../managed/L2/contract/index.cjs";
import { type L2PrivateState, witnesses } from "../witnesses.js";

export class L2Simulator {
  readonly contract: Contract<L2PrivateState>;
  circuitContext: CircuitContext<L2PrivateState>;
  private signers: { sk: bigint; pk: CurvePoint }[];

  constructor() {
    this.contract = new Contract<L2PrivateState>(witnesses);

    // Generate 3 random key pairs (deterministically for tests)
    // Use small values to ensure they're well within the field
    this.signers = [];
    for (let i = 1; i <= 3; i++) {
      const sk = BigInt(i + 100);
      const pk = pureCircuits.derivePk(sk);
      this.signers.push({ sk, pk });
    }

    const {
      currentPrivateState,
      currentContractState,
      currentZswapLocalState
    } = this.contract.initialState(
      constructorContext({ privateState: 0 }, "0".repeat(64)),
      this.signers.map((s) => s.pk),
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

    const JUBJUB_SCALAR_FIELD =
      6554484396890773809930967563523245729705921265872317281365359162392183254199n;
    let attempt = 0;
    while (true) {
      attempt++;
      const k = BigInt((signerIndex + 1) * 12345 + attempt);
      const sig = pureCircuits.sign(val, this.signers[signerIndex].sk, k);
      if (sig.s < JUBJUB_SCALAR_FIELD) {
        return sig;
      }
    }
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
