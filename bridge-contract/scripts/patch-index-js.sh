#!/usr/bin/env bash
#
# Patch generated index.js to fix Compact compiler issues:
#
# 1. JubjubPoint equality: The Compact compiler (<=0.30.0) emits `===` for
#    the `==` operator on JubjubPoint values, but JubjubPoint is a plain
#    {x: bigint, y: bigint} object.  JavaScript `===` is reference equality,
#    so two distinct objects representing the same curve point compare as false.
#    Fix: compare .x and .y fields explicitly (affects _verifySignature_0 and
#    _verifyThresholdSignatures_0 WRONG_SIGNER checks).
#
# 2. Schnorr signature Field/EmbeddedFr mismatch: Compact's `Field` type is
#    the BLS12-381 scalar field (mod p), but ecMulGenerator / ecMul expect
#    scalars in the JubJub scalar field (mod q, where q ≈ p/8).  The compiled
#    `sign` computes s = nonce + c*sk using Field arithmetic (mod p), but
#    verification calls ecMulGenerator(s) and ecMul(pk, c) which reject
#    scalars >= q ("failed to decode for built-in type EmbeddedFr").
#    Even when scalars happen to be < q, the mod-p reduction of c*sk produces
#    a different value from the true c*sk, so the signature is mathematically
#    wrong.  Fix: compute s using bigint arithmetic mod q in sign, and reduce
#    scalars mod q before curve operations in verify.
#
# Run after `compact compile` and before `npm run build`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_TARGET="$SCRIPT_DIR/../src/managed/Bridge/contract/index.js"
DIST_TARGET="$SCRIPT_DIR/../dist/managed/Bridge/contract/index.js"

JUBJUB_Q='6554484396890773809930967563523245729705921265872317281365359162392183254199n'

patch_file() {
  local TARGET="$1"

  # Patch 1: JubjubPoint equality in _verifySignature_0 — reference → field comparison
  sed -i 's/return lhs_0 === rhs_0;/return lhs_0.x === rhs_0.x \&\& lhs_0.y === rhs_0.y;/' "$TARGET"

  # Patch 2: _sign_0 — compute s = (nonce + c * sk) mod q using bigint math
  #          instead of addField/mulField which use BLS12-381 Field (mod p)
  perl -0777 -i -pe \
    "s/__compactRuntime\\.addField\\(nonce_0,\\s+__compactRuntime\\.mulField\\(c_0, sk_0\\)\\)/(nonce_0 + c_0 * sk_0) % ${JUBJUB_Q}/g" \
    "$TARGET"

  # Patch 3: _verifySignature_0 — reduce s mod q for ecMulGenerator
  sed -i "s/this\\._ecMulGenerator_0(s_0)/this._ecMulGenerator_0(s_0 % ${JUBJUB_Q})/" "$TARGET"

  # Patch 4: _verifySignature_0 — reduce c mod q for ecMul
  sed -i "s/this\\._ecMul_0(pk_0, c_0)/this._ecMul_0(pk_0, c_0 % ${JUBJUB_Q})/" "$TARGET"

  # Patch 5: WRONG_SIGNER_N checks — signatures_0[N].pk === (on-chain pk)
  #          The === is reference equality on {x,y} objects; always false for
  #          distinct objects.  Rewrite to field-wise comparison using an IIFE.
  #          Transform: assert(sig[N].pk === EXPR, 'WRONG_SIGNER_N')
  #          Into:      assert(((a,b)=>a.x===b.x&&a.y===b.y)(sig[N].pk, EXPR), 'WRONG_SIGNER_N')
  perl -0777 -i -pe \
    "s/(signatures_0\[(\d+)\])\.pk\s*===\s*(_descriptor_2)/((a,b)=>a.x===b.x\&\&a.y===b.y)(\$1.pk,\$3/g" \
    "$TARGET"
  # The IIFE call needs a closing ')' before the 'WRONG_SIGNER' message.
  # The original ends: ...value)[N], 'WRONG_SIGNER_N')
  # After the above, the opening '(' from the IIFE is unmatched.
  # Close it by adding ')' before each WRONG_SIGNER assertion message.
  for i in 0 1 2; do
    sed -i "s/\\.value)\\[$i\\],/\\.value)[$i]),/" "$TARGET"
  done

  echo "patch-index-js: patched $TARGET"
}

if [ ! -f "$SRC_TARGET" ]; then
  echo "patch-index-js: $SRC_TARGET not found, skipping"
  exit 0
fi

patch_file "$SRC_TARGET"

# Also patch dist/ if it exists (built copy used by tests before next full build).
if [ -f "$DIST_TARGET" ]; then
  patch_file "$DIST_TARGET"
fi
