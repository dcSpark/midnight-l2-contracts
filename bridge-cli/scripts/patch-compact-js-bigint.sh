#!/usr/bin/env bash
#
# Patch compact-js-command to fix BigInt parsing of nested JSON5 string values.
#
# Bug: when a BigInt field is inside a struct inside an array, the parser
# double-stringifies via JSON5.stringify which wraps string values in single
# quotes. The BigInt handler doesn't strip these quotes, so BigInt("'123'")
# fails. StringKeyword and Uint8Array handlers already strip quotes using
# the `quotedStrings` flag, but BigIntKeyword doesn't.
#
# This patch adds quote-stripping to the BigIntKeyword handler, matching
# the pattern used by StringKeyword and Uint8Array.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/../.."

TARGET="$REPO_ROOT/midnight-node/util/toolkit-js/node_modules/@midnight-ntwrk/compact-js-command/dist/esm/effect/internal/compiledContractReflection.js"

if [ ! -f "$TARGET" ]; then
  echo "patch-compact-js-bigint: $TARGET not found, skipping"
  exit 0
fi

# Check if already patched (patched line has quotedStrings before BigInt)
if grep -q "BigInt(quotedStrings" "$TARGET" 2>/dev/null; then
  echo "patch-compact-js-bigint: already patched"
  exit 0
fi

# Replace `return BigInt(args[idx]);` with quote-stripping version
sed -i 's/return BigInt(args\[idx\]);/return BigInt(quotedStrings ? args[idx].replaceAll("'"'"'", "") : args[idx]);/' "$TARGET"

echo "patch-compact-js-bigint: patched $TARGET"
