/**
 * Contract artifact `signBytes32` / `verifyBytes32` should agree for a Schnorr signature.
 * This test uses a single nonce and the first verifier key; it is expected to FAIL until
 * signing/verification in the compiled host (or circuit) is fixed.
 *
 * Verifier secret keys match defaults used elsewhere: 101, 102, 103.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Bridge } from 'bridge-contract/browser';
import { hexToBytes32 } from '../batch-helpers.js';

const VERIFIER_SECRET_KEYS = '101,102,103' as const;
const FIRST_VERIFIER_SK = 101n;
const NONCE = 1n;

describe('pureCircuits signBytes32 / verifyBytes32', () => {
  beforeEach(() => {
    vi.stubEnv('VERIFIER_SECRET_KEYS', VERIFIER_SECRET_KEYS);
  });

  it('verifyBytes32 accepts signBytes32 output (single nonce)', () => {
    const digest = hexToBytes32('01'.repeat(32));
    const sig = Bridge.pureCircuits.signBytes32(digest, FIRST_VERIFIER_SK, NONCE);
    let verified = false;
    try {
      verified = Bridge.pureCircuits.verifyBytes32(digest, sig);
    } catch {
      /* verifyBytes32 may throw (e.g. EmbeddedFr decode) until fixed */
    }
    expect(verified).toBe(true);
  });
});
