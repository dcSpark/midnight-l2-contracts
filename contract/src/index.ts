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

// Export the Bridge contract module (L1 unified contract)
export * as Bridge from "./managed/Bridge/contract/index.js";

// Export the L2 simulation contract module
export * as L2 from "./managed/L2/contract/index.js";

// Export witnesses and protocol types
export * from "./witnesses";
export * from "./protocol-types";
