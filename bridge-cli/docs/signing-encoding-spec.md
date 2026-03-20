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
- `s`: bigint — the proof-system **`Field`** value `addField(nonce, mulField(c, sk))` in `[0, maxField()]`. It often satisfies `s ≥ q` (Jubjub subgroup order `q` = `JUBJUB_SCALAR_FIELD` in `ledger-signer.ts`). **Do not** replace `s` with `s mod q` for transactions: the contract witness must carry the exact `Field` result or `finalizeBatch` fails (`BAD_SIG_*`). On the curve, `ecMulGenerator` uses the scalar `s mod q`; the ledger still stores and checks the full `Field` `s`.

Field elements for challenges and `mulField` inputs use the proof-system scalar field (`maxField()`).

## 4. Sign algorithm (Signer.compact + JS interop)

- `sk' = sk mod q`, `nonce' = nonce mod q` (for `ecMulGenerator` only; same curve points as reducing full field scalars)
- `pk = ecMulGenerator(sk')`
- `r = ecMulGenerator(nonce')`
- `c = computeChallenge(r, pk, msg)` then canonicalize `c` in the proof-system field
- `s = addField(nonce, mulField(c, sk))` with **canonical** `nonce` and `sk` in `[0, maxField]` (matches compiled `Signer._sign_0` — **no** extra `mod q` on `s`)
- Return `Signature { pk, r, s }`

## 5. Verify algorithm (local / spec)

- `c = computeChallenge(r, pk, msg)` (canonical field)
- For the LHS only, `s_fr = (s mod q)` in `[0, q)` so TypeScript `ecMulGenerator` accepts `EmbeddedFr`
- Check `ecMulGenerator(s_fr)` equals `ecAdd(r, ecMul(pk, c))` (compare `x` and `y`)

Point equality is done by comparing the two field elements (x, y) of the resulting points.
