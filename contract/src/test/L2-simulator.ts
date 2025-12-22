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
  type CircuitContext,
  createCircuitContext,
  createConstructorContext,
  type CurvePoint,
  sampleContractAddress
} from "@midnight-ntwrk/compact-runtime";
import { encodeContractAddress } from "@midnight-ntwrk/ledger";
import { nativeToken } from "@midnight-ntwrk/zswap";
import {
  Contract,
  type Ledger,
  ledger,
  pureCircuits,
  type Signature,
  WithdrawInfo
} from "../managed/L2/contract/index.js";
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
      createConstructorContext({ privateState: 0 }, "0".repeat(64)),
      this.signers.map((s) => s.pk),
      new Uint8Array(32)
    );

    // Use createCircuitContext for the new runtime API
    this.circuitContext = createCircuitContext(
      sampleContractAddress(),
      currentZswapLocalState.coinPublicKey,
      currentContractState.data,
      currentPrivateState
    );
  }

  public getLedger(): Ledger {
    return ledger(this.circuitContext.currentQueryContext.state);
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

  public signStateRootUpdate(val: Uint8Array, signerIndex: number): Signature {
    return this._signWithGrinding(
      (k) =>
        pureCircuits.signStateRootUpdate(val, this.signers[signerIndex].sk, k),
      signerIndex
    );
  }

  public signWithdraw(wi: WithdrawInfo, signerIndex: number): Signature {
    return this._signWithGrinding(
      (k) => pureCircuits.signWithdraw(wi, this.signers[signerIndex].sk, k),
      signerIndex
    );
  }

  private _signWithGrinding(
    _signFn: (_: bigint) => Signature,
    signerIndex: number
  ): Signature {
    if (signerIndex < 0 || signerIndex >= this.signers.length) {
      throw new Error("Invalid signer index");
    }
    const JUBJUB_SCALAR_FIELD =
      6554484396890773809930967563523245729705921265872317281365359162392183254199n;
    let attempt = 0;
    while (true) {
      attempt++;
      const k = BigInt((signerIndex + 1) * 12345 + attempt);
      const sig = _signFn(k);
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
    return ledger(this.circuitContext.currentQueryContext.state);
  }

  public deposit(amount: bigint, l2_receiver: Uint8Array): bigint {
    const result = this.contract.impureCircuits.deposit(
      this.circuitContext,
      {
        nonce: new Uint8Array(32),
        color: encodeContractAddress(nativeToken()),
        value: amount
      },
      l2_receiver
    );
    this.circuitContext = result.context;
    return result.result;
  }

  public withdraw(withdrawInfo: WithdrawInfo, signature: Signature): void {
    this.circuitContext = this.contract.impureCircuits.withdraw(
      this.circuitContext,
      withdrawInfo,
      signature
    ).context;
  }

  public getBalance(user: Uint8Array): bigint {
    return this.contract.impureCircuits.getBalance(this.circuitContext, {
      bytes: user
    }).result;
  }
}
