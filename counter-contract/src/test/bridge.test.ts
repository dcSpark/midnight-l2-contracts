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

import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { describe, expect, it } from "vitest";
import { L2Simulator } from "./L2Simulation-simulator.js";
import { computeZeroHash } from "../protocol-types";

setNetworkId("undeployed");

describe("The bridge", () => {
  it("initializes the withdraw queue state", () => {
    const simulator = new L2Simulator();

    const userPubKey = new Uint8Array(32); // TODO: get through witnesses.ts
    expect(simulator.getBalance(userPubKey)).toEqual(0n);
    expect(simulator.getWithdrawMessageCount()).toEqual(0n);
    expect(simulator.getWithdrawRoot()).toEqual(computeZeroHash(15));
  });

  it("rejects withdrawals without a balance", () => {
    const simulator = new L2Simulator();
    expect(() =>
      simulator.withdrawNIGHT(new Uint8Array(32), 1n)
    ).toThrow();
  });
});
