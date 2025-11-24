import * as runtime from '@midnight-ntwrk/compact-runtime';
import { type CurvePoint, degradeToTransient, ecMulGenerator } from '@midnight-ntwrk/compact-runtime';

export type Signature = {
  r: CurvePoint;
  s: bigint;
};

export class Signer {
  private signers: { sk: bigint; pk: CurvePoint }[];
  public signersPub: CurvePoint[];

  constructor() {
    this.signers = [];
    this.signersPub = [];

    // Generate 3 random key pairs (deterministically for tests)
    // Use small values to ensure they're well within the field
    for (let i = 1; i <= 3; i++) {
      const sk = BigInt(i + 100); // Simple small deterministic keys
      const pk = ecMulGenerator(sk);
      this.signers.push({ sk, pk });
      this.signersPub.push(pk);
    }
  }

  public getPublicKey(signerIndex: number): CurvePoint {
    if (signerIndex < 0 || signerIndex >= this.signers.length) {
      throw new Error('Invalid signer index');
    }
    return this.signers[signerIndex].pk;
  }

  public sign(val: Uint8Array, signerIndex: number): Signature {
    if (signerIndex < 0 || signerIndex >= this.signers.length) {
      throw new Error('Invalid signer index');
    }
    const { sk, pk } = this.signers[signerIndex];
    const msgField = degradeToTransient(val);

    // The embedded curve (Jubjub) scalar field order
    const JUBJUB_SCALAR_FIELD = 6554484396890773809930967563523245729705921265872317281365359162392183254199n;

    // Create a CompactType for the tuple [CurvePoint, CurvePoint, Field]
    const tupleType = {
      alignment: () => [
        { tag: 'atom' as const, value: { tag: 'field' as const } },
        { tag: 'atom' as const, value: { tag: 'field' as const } },
        { tag: 'atom' as const, value: { tag: 'field' as const } },
        { tag: 'atom' as const, value: { tag: 'field' as const } },
        { tag: 'atom' as const, value: { tag: 'field' as const } },
      ],
      toValue: (val: [CurvePoint, CurvePoint, bigint]) => [
        ...runtime.bigIntToValue(val[0].x),
        ...runtime.bigIntToValue(val[0].y),
        ...runtime.bigIntToValue(val[1].x),
        ...runtime.bigIntToValue(val[1].y),
        ...runtime.bigIntToValue(val[2]),
      ],
      fromValue: (_: any) => {
        throw new Error('Not implemented');
      },
    };

    // Grind for a valid e that fits in the Jubjub scalar field
    let k, r, e;
    let attempt = 0;
    while (true) {
      attempt++;
      k = BigInt((signerIndex + 1) * 12345 + attempt);
      r = ecMulGenerator(k);

      e = runtime.transientHash(tupleType, [r, pk, msgField]);

      if (e < JUBJUB_SCALAR_FIELD) {
        break;
      }
    }

    // For Schnorr: s = k + e*sk mod q
    const s = (k + e * sk) % JUBJUB_SCALAR_FIELD;

    return { r, s };
  }
}
