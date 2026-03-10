#!/usr/bin/env bash
#
# Patch generated index.d.ts to inline type aliases in circuit signatures.
#
# The compact-js-command argument parser (used by midnight-node-toolkit
# generate-intent circuit) cannot resolve named TypeScript type aliases --
# it only handles inline type literals. This script replaces the three
# affected type references with their inlined definitions.
#
# Run after `compact compile` and before `npm run build` (the build script
# copies src/managed -> dist/managed, so patching src/ is sufficient).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$SCRIPT_DIR/../src/managed/Bridge/contract/index.d.ts"

if [ ! -f "$TARGET" ]; then
  echo "patch-index-dts: $TARGET not found, skipping"
  exit 0
fi

# 1. L1_WithdrawProof16 -> inline struct (used in relayWithdrawNIGHTWithProof)
sed -i 's/proof__0: L1_WithdrawProof16/proof__0: { batchIndex: bigint; nonce: bigint; indexBits: boolean[]; siblings: Uint8Array[] }/g' "$TARGET"

# 2. L1_BatchPublicDataV1Full -> inline struct (used in finalizeBatch)
sed -i 's/batchPublicData__0: L1_BatchPublicDataV1Full/batchPublicData__0: { version: bigint; layer2ChainId: bigint; rollupId: Uint8Array; batchIndex: bigint; daStartHeight: bigint; daEndHeight: bigint; daCommitment: Uint8Array; lastProcessedQueueIndex: bigint; messageQueueHash: Uint8Array; prevStateRoot: Uint8Array; prevBatchHash: Uint8Array; postStateRoot: Uint8Array; batchHash: Uint8Array; withdrawRoot: Uint8Array }/g' "$TARGET"

# 3. Signature[] -> inline struct array (used in finalizeBatch)
sed -i 's/signatures__0: Signature\[\]/signatures__0: { pk: { x: bigint, y: bigint }; r: { x: bigint, y: bigint }; s: bigint }[]/g' "$TARGET"

echo "patch-index-dts: patched $TARGET"
