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
import { L2Simulator } from "./L2-simulator.js";

setNetworkId(NetworkId.Undeployed);

describe("The bridge", () => {
  it("enables nativeToken deposit", () => {
    const simulator = new L2Simulator();

    const userPubKey = new Uint8Array(32); // TODO: get through witnesses.ts
    const initBalance = simulator.getBalance(userPubKey);
    expect(initBalance).toEqual(0n);

    simulator.deposit(1_234_000n, new Uint8Array(32));

    const balance = simulator.getBalance(userPubKey);
    expect(balance).toEqual(1_234_000n);
  });

  it("enables nativeToken withdrawal", () => {
    const simulator = new L2Simulator();

    const userPubKey = new Uint8Array(32); // TODO: get through witnesses.ts
    const depositId = simulator.deposit(1_234_000n, new Uint8Array(32));
    const balance = simulator.getBalance(userPubKey);
    expect(balance).toEqual(1_234_000n);

    const sig = simulator.signWithdraw(
      { depositId, l1Receiver: { bytes: userPubKey } },
      0
    );
    simulator.withdraw({ depositId, l1Receiver: { bytes: userPubKey } }, sig);

    const balanceAfter = simulator.getBalance(userPubKey);
    expect(balanceAfter).toEqual(0n);
  });
});
