# Signing and batch digest encoding spec

This document specifies the exact encodings used for offchain signing so that TypeScript and Rust implementations produce signatures that verify on the Bridge contract. The contract uses Compact’s `Signer` and `L1Rollup.hashBatchPublicDataV1Full`; encodings must match the compiled artifact.

## 1. Challenge encoding (for Fiat–Shamir)

Used in `computeChallenge(r, pk, msg)` in Signer.compact:

- **Formula**: `c = degradeToTransient(persistentHash(Challenge { r, pk, msg }))`
- **Challenge layout**: struct with `r: NativePoint`, `pk: NativePoint`, `msg: Bytes<32>`.
- **NativePoint**: two Field elements `(x, y)`.
- **Field**: one segment, alignment `{ tag: 'atom', value: { tag: 'field' } }`; value = `bigIntToValue(f)` (ledger’s field-aligned encoding).
- **Bytes<32>**: one segment, alignment `{ tag: 'atom', value: { tag: 'bytes', length: 32 } }`; value = `[msg]` (single 32-byte chunk).

**Alignment for Challenge<Bytes<32>>** (in order):

1. `r.x`: field  
2. `r.y`: field  
3. `pk.x`: field  
4. `pk.y`: field  
5. `msg`: bytes(32)

So alignment = 4× field + 1× bytes(32).

**Value**: concatenation

- `pointToValue(r)` = `bigIntToValue(r.x).concat(bigIntToValue(r.y))`
- `pointToValue(pk)` = same for pk
- `msg` = `[new Uint8Array(msg)]` (one 32-byte chunk)

Full value = `pointToValue(r).concat(pointToValue(pk)).concat([msg])`.

**degradeToTransient**: input is the 32-byte output of `persistentHash` as a Value (e.g. `[hashBytes]`). Output is a Value encoding a field element; use `valueToBigInt` to get the scalar `c`.

## 2. Batch public data digest (hashBatchPublicDataV1Full)

Used in L1Rollup.compact and when signing the digest in finalize-batch.

- **Formula**: `digest = persistentHash(Vector<14, Bytes<32>>, value)`
- **Layout**: 14 segments, each Bytes<32>, in this order:

1. Domain: `pad(32, "mdn:bpd:v1full")` (32 bytes, null-padded)
2. `version` as Bytes<32> (contract uses `(b.version as Field) as Bytes<32>`; use same encoding as Compact’s convertFieldToBytes(32, version))
3. `layer2ChainId`: u64 LE in 32 bytes
4. `rollupId`: 32 bytes
5. `batchIndex`: u64 LE in 32 bytes
6. `daStartHeight`: u64 LE in 32 bytes
7. `daEndHeight`: u64 LE in 32 bytes
8. `daCommitment`: 32 bytes
9. `lastProcessedQueueIndex`: u64 LE in 32 bytes
10. `messageQueueHash`: 32 bytes
11. `prevStateRoot`: 32 bytes
12. `prevBatchHash`: 32 bytes
13. `postStateRoot`: 32 bytes
14. `withdrawRoot`: 32 bytes

Note: **batchHash is not included** in the hash input (per L1Rollup.compact lines 675–691).

**Alignment**: 14 × `{ tag: 'atom', value: { tag: 'bytes', length: 32 } }`.

**Value**: array of 14 Uint8Array(32) in the order above.

## 3. Signature structure

Same as Bridge.Signature:

- `pk`: `{ x: bigint, y: bigint }`
- `r`: `{ x: bigint, y: bigint }`
- `s`: bigint

Field elements and points use the proof system’s scalar field (max value from `maxField()`).

## 4. Sign algorithm (Signer.compact)

- `pk = ecMulGenerator(sk)`
- `r = ecMulGenerator(nonce)`
- `c = computeChallenge(r, pk, msg)` (see §1)
- `s = nonce + c * sk` (in the scalar field)
- Return `Signature { pk, r, s }`

## 5. Verify algorithm

- `c = computeChallenge(r, pk, msg)`
- Check `ecMulGenerator(s) === ecAdd(r, ecMul(pk, c))`

Point equality is done by comparing the two field elements (x, y) of the resulting points.
