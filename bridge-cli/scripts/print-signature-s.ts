/**
 * Print the signature scalar s (decimal) for signer 0 (sk=101) with nonce 1 over the batch digest.
 * Used by decoder-rs integration test to compare Rust vs TS signing.
 *
 * Usage: npx tsx scripts/print-signature-s.ts <path-to-batch-public-data.json>
 */
import { readFileSync } from 'node:fs';
import { signBytes32 } from '../src/ledger-signer.js';
import {
  hashBatchPublicDataV1Full,
  parseBatchPublicDataFromJson,
} from '../src/batch-helpers.js';

const path = process.argv[2];
if (!path) {
  console.error(
    'Usage: npx tsx scripts/print-signature-s.ts <path-to-batch-public-data.json>',
  );
  process.exit(1);
}

const json = readFileSync(path, 'utf8');
const batch = parseBatchPublicDataFromJson(json);
const digest = hashBatchPublicDataV1Full(batch);
// Same as Rust: sk=101, nonce=1 (Rust skips nonce 0)
const sig = signBytes32(digest, 101n, 1n);
console.log(sig.s.toString());
