import { describe, it, expect } from 'vitest';
import { decompressXz } from '../../src/lib/xz';

// `xz -6` output for PAYLOAD: an 8 MiB LZMA2 dictionary and CRC64, as dpkg-deb writes control.tar.xz.
const FIXTURE = Uint8Array.fromBase64(
  '/Td6WFoAAATm1rRGBMDbAuCnEiEBFgAAAAAAALHkTNnkk98BU10AAABSUAqE+ZuygCGpadYn4D4GWl8EjVPUBLo5VwUJwVUk3p24cVkxYKGf+W9Jc/LI6oy6GospaSGA/jODZq9GbeyeiYoLg/A8DomOP+1f556Q2Rz/MvSy4DlRstIUFbTFcbrbBuN5mp+7OMGwAKyTC6oGGQMSCBVbm8hI8DIu/i2gh8jwpODSUeuNZ1aSsk2ExfGGMd9qYlvCeS3Z9zxzunR0B9g8qVYiJKFm+FqEXzBn0vZLSS5/IOvb+BAOlHh3xz9r77TNleJv9kRuBs8LghrL23rwV42Y/5DAPubBEkF17gOeqOh6BJXRvsB+Z3J64Lq9Wf/L3bPS0+wj+QueNz2/1YNSigbtQf0T+4UAjf86gCaAg1GsK26oKzSuWznqv4YifCxE9b3RP/BsGcIMvxUKku9nqqDMX+9VMaJ81V3rhkITPWegRPg3LWDd63DKnJQAAAD+Q9n70dm4jwAB9wLgpxIAEtS+w7HEZ/sCAAAAAARZWg=='
);

// Spans several of xzwasm's 64 KiB output buffers, and no two buffers hold the same bytes.
const PAYLOAD = Uint8Array.from({ length: 300_000 }, (_, i) => i % 251);

/** Returns the offset of the first byte that differs from PAYLOAD, or -1 if it matches. */
function mismatch(output: Uint8Array): number {
  if (output.length !== PAYLOAD.length) return Math.min(output.length, PAYLOAD.length);
  return output.findIndex((byte, i) => byte !== PAYLOAD[i]);
}

describe('decompressXz', () => {
  it('decompresses output spanning several output buffers', () => {
    expect(mismatch(decompressXz(FIXTURE))).toBe(-1);
  });

  it('keeps output intact across concurrent decompressions', async () => {
    const outputs = await Promise.all(Array.from({ length: 8 }, async () => decompressXz(FIXTURE)));
    expect(outputs.map(mismatch)).toEqual(Array(8).fill(-1));
  });

  it('throws on truncated input', () => {
    expect(() => decompressXz(FIXTURE.subarray(0, 200))).toThrow();
    expect(() => decompressXz(FIXTURE.subarray(0, FIXTURE.length - 1))).toThrow();
  });

  it('throws on input that is not xz', () => {
    expect(() => decompressXz(new Uint8Array(100))).toThrow();
    expect(() => decompressXz(new Uint8Array(0))).toThrow();
  });

  it('still decompresses after a failure', () => {
    expect(() => decompressXz(FIXTURE.subarray(0, 200))).toThrow();
    expect(mismatch(decompressXz(FIXTURE))).toBe(-1);
  });
});
