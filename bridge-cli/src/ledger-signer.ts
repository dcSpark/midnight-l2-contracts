/**
 * Offchain signing using @midnight-ntwrk/compact-runtime primitives only
 * (same runtime as the Bridge contract, no contract-specific compiled code).
 * Produces signatures that verify on the Bridge contract (Signer.compact).
 * Encoding spec: bridge-cli/docs/signing-encoding-spec.md
 */
import {
  CompactTypeJubjubPoint,
  CompactTypeBytes,
  persistentHash,
  degradeToTransient,
  addField,
  mulField,
  ecMulGenerator,
  ecMul,
  ecAdd,
  MAX_FIELD,
  type JubjubPoint,
} from '@midnight-ntwrk/compact-runtime';

const MODULUS = MAX_FIELD + 1n;

/** Jubjub subgroup order; TS `ecMulGenerator` only accepts scalars in `[0, q)`. */
const JUBJUB_SCALAR_FIELD =
  6554484396890773809930967563523245729705921265872317281365359162392183254199n;

function canonField(x: bigint): bigint {
  const r = x % MODULUS;
  return r >= 0n ? r : r + MODULUS;
}

function modJubjubScalar(x: bigint): bigint {
  const r = x % JUBJUB_SCALAR_FIELD;
  return r >= 0n ? r : r + JUBJUB_SCALAR_FIELD;
}

const Bytes32 = new CompactTypeBytes(32);

/** Descriptor for Challenge { r, pk, msg } used in Fiat–Shamir. */
const ChallengeBytes32Descriptor = {
  alignment(): ReturnType<typeof CompactTypeJubjubPoint.alignment> {
    return CompactTypeJubjubPoint.alignment()
      .concat(CompactTypeJubjubPoint.alignment())
      .concat(Bytes32.alignment());
  },
  toValue(v: { r: JubjubPoint; pk: JubjubPoint; msg: Uint8Array }) {
    return CompactTypeJubjubPoint.toValue(v.r)
      .concat(CompactTypeJubjubPoint.toValue(v.pk))
      .concat(Bytes32.toValue(v.msg));
  },
  fromValue(_value: Uint8Array[]) {
    throw new Error('ChallengeBytes32Descriptor.fromValue not used');
  },
};

export type Signature = {
  pk: { x: bigint; y: bigint };
  r: { x: bigint; y: bigint };
  s: bigint;
};

export function computeChallenge(
  r: JubjubPoint,
  pk: JubjubPoint,
  msg: Uint8Array,
): bigint {
  const persistent = persistentHash(ChallengeBytes32Descriptor, { r, pk, msg });
  return degradeToTransient(persistent);
}

/**
 * Sign a 32-byte message with the given secret key and nonce.
 * Matches `Signer.compact` / compiled `_sign_0`: `s = addField(nonce, mulField(c, sk))`.
 * `pk`/`r` use `modJubjubScalar` so `ecMulGenerator` accepts `EmbeddedFr` in JS.
 */
export function signBytes32(
  msg: Uint8Array,
  sk: bigint,
  nonce: bigint,
): Signature {
  if (msg.length !== 32) {
    throw new Error('signBytes32: msg must be 32 bytes');
  }
  const skF = canonField(sk);
  const nonceF = nonce === 0n ? 1n : canonField(nonce);
  const pk = ecMulGenerator(modJubjubScalar(skF));
  const r = ecMulGenerator(modJubjubScalar(nonceF));
  const c = computeChallenge(r, pk, msg);
  const s = (nonceF + canonField(c) * skF) % JUBJUB_SCALAR_FIELD;
  return { pk, r, s };
}

/**
 * Verify a signature over a 32-byte message.
 */
export function verifyBytes32(msg: Uint8Array, sig: Signature): boolean {
  if (msg.length !== 32) {
    return false;
  }
  const c = canonField(computeChallenge(sig.r, sig.pk, msg));
  const lhs = ecMulGenerator(modJubjubScalar(canonField(sig.s)));
  const rhs = ecAdd(sig.r, ecMul(sig.pk, modJubjubScalar(c)));
  return lhs.x === rhs.x && lhs.y === rhs.y;
}

/**
 * Derive public key (curve point) from secret key.
 */
export function derivePk(sk: bigint): JubjubPoint {
  return ecMulGenerator(modJubjubScalar(canonField(sk)));
}

/** Vector<14, Bytes<32>> descriptor for batch digest. */
const BatchDigestDescriptor = {
  alignment() {
    let a = Bytes32.alignment();
    for (let i = 0; i < 13; i++) {
      a = a.concat(Bytes32.alignment());
    }
    return a;
  },
  toValue(chunks: Uint8Array[]) {
    if (chunks.length !== 14) {
      throw new Error('expected 14 chunks of 32 bytes');
    }
    return chunks.reduce<Uint8Array[]>(
      (acc, c) => acc.concat(Bytes32.toValue(c)),
      [],
    );
  },
  fromValue(_value: Uint8Array[]) {
    throw new Error('BatchDigestDescriptor.fromValue not used');
  },
};

/**
 * Compute the batch public data digest using persistentHash (matches contract).
 * chunks: 14 × Uint8Array(32) in order per signing-encoding-spec.md.
 */
export function hashBatchPublicDataV1FullLedger(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length !== 14) {
    throw new Error('hashBatchPublicDataV1FullLedger: expected 14 chunks of 32 bytes');
  }
  chunks.forEach((c, i) => {
    if (c.length !== 32) {
      throw new Error(`Chunk ${i} must be 32 bytes`);
    }
  });
  return persistentHash(BatchDigestDescriptor, chunks);
}
