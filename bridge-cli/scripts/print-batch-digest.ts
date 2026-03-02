/**
 * Print the batch public data digest (64-char hex) for a given batch JSON file.
 * Used by decoder-rs integration test to compare Rust vs TS digest.
 *
 * Usage: npx tsx scripts/print-batch-digest.ts <path-to-batch-public-data.json>
 */
import { readFileSync } from 'node:fs';
import {
  hashBatchPublicDataV1Full,
  parseBatchPublicDataFromJson,
} from '../src/batch-helpers.js';

const path = process.argv[2];
if (!path) {
  console.error('Usage: npx tsx scripts/print-batch-digest.ts <path-to-batch-public-data.json>');
  process.exit(1);
}

const json = readFileSync(path, 'utf8');
const batch = parseBatchPublicDataFromJson(json);
const digest = hashBatchPublicDataV1Full(batch);
const hex = Buffer.from(digest).toString('hex');
console.log(hex);
