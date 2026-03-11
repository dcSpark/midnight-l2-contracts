#!/usr/bin/env bash
# Generate a Bridge circuit-call intent file for the time-to-dismiss test pipeline.
#
# Prerequisites:
#   - midnight-node-toolkit on PATH (or set TOOLKIT_BIN)
#   - Bridge contract config for toolkit-js (config.ts that points to Bridge artifacts)
#   - State file: tagged-serialized ContractState. Obtain by:
#       midnight-node-toolkit contract-state \
#         --src-file <genesis.mn> [--src-file <deploy_tx.mn> ...] \
#         --contract-address <bridge-address> \
#         --dest-file state.bin
#   - Private state JSON for the circuit (e.g. initial Bridge private state)
#
# Usage:
#   TOOLKIT_BIN=midnight-node-toolkit \\
#   BRIDGE_CONFIG=/path/to/bridge.config.ts \\
#   TOOLKIT_JS_PATH=/path/to/midnight-node/util/toolkit-js \\
#   STATE_FILE=./state.bin \\
#   PRIVATE_STATE_JSON=./initial_private_state.json \\
#   CONTRACT_ADDRESS=<64-char-hex> \\
#   COIN_PUBLIC=<hex> \\
#   OUTPUT_INTENT=./intent.bin \\
#   ./scripts/generate-test-intent.sh depositNIGHTUnshielded 1234 <l2_recipient_hex> 100000 0
#
# Then run decoder-rs time-to-dismiss test with INTENT_FILE=./intent.bin and BRIDGE_ARTIFACTS.

set -euo pipefail

TOOLKIT_BIN="${TOOLKIT_BIN:-midnight-node-toolkit}"
BRIDGE_CONFIG="${BRIDGE_CONFIG:?Set BRIDGE_CONFIG to path of Bridge toolkit-js config}"
TOOLKIT_JS_PATH="${TOOLKIT_JS_PATH:?Set TOOLKIT_JS_PATH to midnight-node/util/toolkit-js}"
STATE_FILE="${STATE_FILE:?Set STATE_FILE to tagged-serialized contract state (e.g. from contract-state command)}"
PRIVATE_STATE_JSON="${PRIVATE_STATE_JSON:?Set PRIVATE_STATE_JSON to path of initial private state JSON}"
CONTRACT_ADDRESS="${CONTRACT_ADDRESS:?Set CONTRACT_ADDRESS (64 hex chars)}"
COIN_PUBLIC="${COIN_PUBLIC:?Set COIN_PUBLIC (hex)}"
OUTPUT_INTENT="${OUTPUT_INTENT:-./intent.bin}"
OUTPUT_PS="${OUTPUT_PS:-./ps_state.json}"
OUTPUT_ZSWAP="${OUTPUT_ZSWAP:-./zswap_state.json}"
NETWORK="${NETWORK:-undeployed}"

CIRCUIT_ID="${1:?Circuit name, e.g. depositNIGHTUnshielded}"
shift
CALL_ARGS=("$@")

"$TOOLKIT_BIN" generate-intent circuit \
  -c "$BRIDGE_CONFIG" \
  --toolkit-js-path "$TOOLKIT_JS_PATH" \
  --network "$NETWORK" \
  --coin-public "$COIN_PUBLIC" \
  --input-onchain-state "$STATE_FILE" \
  --input-private-state "$PRIVATE_STATE_JSON" \
  --contract-address "$CONTRACT_ADDRESS" \
  --output-intent "$OUTPUT_INTENT" \
  --output-private-state "$OUTPUT_PS" \
  --output-zswap-state "$OUTPUT_ZSWAP" \
  "$CIRCUIT_ID" \
  "${CALL_ARGS[@]}"

echo "Written intent to $OUTPUT_INTENT"
