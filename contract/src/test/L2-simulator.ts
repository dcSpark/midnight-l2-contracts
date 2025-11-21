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
  type CircuitContext,
  constructorContext,
  QueryContext,
  sampleContractAddress
} from "@midnight-ntwrk/compact-runtime";
import {
  Contract,
  type Ledger,
  ledger
} from "../managed/L2/contract/index.cjs";
import { type L2PrivateState, witnesses } from "../witnesses.js";

// This is over-kill for such a simple contract, but the same pattern can be used to test more
// complex contracts.
export class L2Simulator {
  readonly contract: Contract<L2PrivateState>;
  circuitContext: CircuitContext<L2PrivateState>;

  constructor() {
    this.contract = new Contract<L2PrivateState>(witnesses);
    const initialSigners = new Array<Uint8Array>(3);
    for (let i = 0; i < 3; i++) {
      const signer = new Uint8Array(32);
      signer[0] = i + 1;
      initialSigners[i] = signer;
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

  public updateStateRoot(val: Uint8Array, signature: Uint8Array): Ledger {
    // Update the current context to be the result of executing the circuit.
    this.circuitContext = this.contract.impureCircuits.updateStateRoot(
      this.circuitContext,
      val,
      signature
    ).context;
    return ledger(this.circuitContext.transactionContext.state);
  }
}
