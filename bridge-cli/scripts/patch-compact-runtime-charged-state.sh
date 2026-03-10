#!/usr/bin/env bash
#
# Patch for finalizeBatch circuit execution: ensure the compiled Bridge
# contract and toolkit-js share the SAME module instances of compact-runtime
# and onchain-runtime-v2.
#
# Root cause: the compiled contract at bridge-contract/dist/managed/Bridge/
# resolves @midnight-ntwrk/compact-runtime from the workspace-root
# node_modules, while toolkit-js has its own copy. The two copies define
# separate ChargedState classes, and instanceof checks across modules fail
# with "expected instance of ChargedState".
#
# Fix: create node_modules symlinks under bridge-contract/ that point to the
# toolkit-js copies, so Node.js resolves the compiled contract's imports to
# the same module instances used by the toolkit.
#
# WARNING: While these symlinks are in place, the normal bridge-cli deploy
# command will fail with "expected instance of ContractMaintenanceAuthority"
# because the workspace-root compact-js loads a different onchain-runtime-v2.
# Use --unpatch to remove the symlinks after running the cost tests.
#
# Must be re-run if bridge-contract/node_modules is deleted or after
# npm install in toolkit-js.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/../.."

TARGET_DIR="$REPO_ROOT/bridge-contract/node_modules/@midnight-ntwrk"

if [ "${1:-}" = "--unpatch" ] || [ "${1:-}" = "--clean" ]; then
  removed=0
  for pkg in compact-runtime onchain-runtime-v2; do
    if [ -L "$TARGET_DIR/$pkg" ]; then
      rm "$TARGET_DIR/$pkg"
      removed=1
    fi
  done
  rmdir "$TARGET_DIR" 2>/dev/null || true
  rmdir "$REPO_ROOT/bridge-contract/node_modules" 2>/dev/null || true
  if [ "$removed" = 1 ]; then
    echo "patch-compact-runtime-charged-state: unpatched (symlinks removed)"
  else
    echo "patch-compact-runtime-charged-state: nothing to unpatch"
  fi
  exit 0
fi

TOOLKIT_NM="$REPO_ROOT/midnight-node/util/toolkit-js/node_modules/@midnight-ntwrk"

if [ ! -d "$TOOLKIT_NM/compact-runtime" ]; then
  echo "patch-compact-runtime-charged-state: toolkit-js compact-runtime not found, skipping"
  exit 0
fi

if [ -L "$TARGET_DIR/compact-runtime" ] && [ -L "$TARGET_DIR/onchain-runtime-v2" ]; then
  echo "patch-compact-runtime-charged-state: already patched"
  exit 0
fi

mkdir -p "$TARGET_DIR"

ln -sfn ../../../midnight-node/util/toolkit-js/node_modules/@midnight-ntwrk/compact-runtime "$TARGET_DIR/compact-runtime"
ln -sfn ../../../midnight-node/util/toolkit-js/node_modules/@midnight-ntwrk/onchain-runtime-v2 "$TARGET_DIR/onchain-runtime-v2"

echo "patch-compact-runtime-charged-state: patched (symlinked bridge-contract → toolkit-js modules)"
