import { type CurvePoint } from '@midnight-ntwrk/compact-runtime';
import { L2 } from 'midnight-l2-contracts';

export class Signer {
  private signers: { sk: bigint; pk: CurvePoint }[];
  public signersPub: CurvePoint[];

  constructor() {
    this.signers = [];
    this.signersPub = [];

    // Generate 3 random key pairs (deterministically for tests)
    // Use small values to ensure they're well within the field
    this.signers = [];
    for (let i = 1; i <= 3; i++) {
      const sk = BigInt(i + 100);
      const pk = L2.pureCircuits.derivePk(sk);
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

  public sign(val: Uint8Array, signerIndex: number): L2.Signature {
    if (signerIndex < 0 || signerIndex >= this.signers.length) {
      throw new Error('Invalid signer index');
    }

    const JUBJUB_SCALAR_FIELD = 6554484396890773809930967563523245729705921265872317281365359162392183254199n;
    let attempt = 0;
    while (true) {
      attempt++;
      const k = BigInt((signerIndex + 1) * 12345 + attempt);
      const sig = L2.pureCircuits.sign(val, this.signers[signerIndex].sk, k);
      if (sig.s < JUBJUB_SCALAR_FIELD) {
        return sig;
      }
    }
  }
}
