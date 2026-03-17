import { describe, expect, it } from 'vitest';
import { resolveConstructorOverrides } from '../commands/deploy.js';

const bytes = (hexByte: string): string => hexByte.repeat(32);

describe('resolveConstructorOverrides', () => {
  it('returns undefined when no overrides are provided', () => {
    expect(resolveConstructorOverrides({})).toBeUndefined();
  });

  it('parses partial overrides and keeps values typed', () => {
    const overrides = resolveConstructorOverrides({
      layer2ChainId: '42',
      rollupId: bytes('ab'),
      signatureThreshold: 2,
    });

    expect(overrides).toBeDefined();
    expect(overrides?.layer2ChainId).toBe(42n);
    expect(Buffer.from(overrides?.rollupId ?? new Uint8Array()).toString('hex')).toBe(bytes('ab'));
    expect(overrides?.signatureThreshold).toBe(2n);
  });

  it('parses all deploy/initialize overrides including verifier set JSON', () => {
    const overrides = resolveConstructorOverrides({
      owner: bytes('11'),
      layer2ChainId: 5n,
      rollupId: bytes('22'),
      genesisStateRoot: bytes('33'),
      genesisBatchHash: bytes('44'),
      verifierSet: JSON.stringify([
        { x: '10', y: '20' },
        { x: '11', y: '21' },
        { x: '12', y: '22' },
      ]),
      signatureThreshold: '3',
      initialSequencer: bytes('55'),
      initialFinalizer: bytes('66'),
    });

    expect(overrides).toEqual({
      owner: new Uint8Array(Buffer.from(bytes('11'), 'hex')),
      layer2ChainId: 5n,
      rollupId: new Uint8Array(Buffer.from(bytes('22'), 'hex')),
      genesisStateRoot: new Uint8Array(Buffer.from(bytes('33'), 'hex')),
      genesisBatchHash: new Uint8Array(Buffer.from(bytes('44'), 'hex')),
      verifierSet: [
        { x: 10n, y: 20n },
        { x: 11n, y: 21n },
        { x: 12n, y: 22n },
      ],
      signatureThreshold: 3n,
      initialSequencer: new Uint8Array(Buffer.from(bytes('55'), 'hex')),
      initialFinalizer: new Uint8Array(Buffer.from(bytes('66'), 'hex')),
    });
  });

  it('rejects out-of-range Uint<8> signature threshold', () => {
    expect(() =>
      resolveConstructorOverrides({
        signatureThreshold: 256,
      }),
    ).toThrow(/signatureThreshold/i);
  });

  it('rejects verifier set with wrong length', () => {
    expect(() =>
      resolveConstructorOverrides({
        verifierSet: [{ x: '1', y: '2' }],
      }),
    ).toThrow(/exactly 3 points/i);
  });
});
