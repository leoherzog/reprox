import { describe, it, expect } from 'vitest';
import { readStreamToBuffer, concatUint8Arrays } from '../../src/utils/streams';

// ============================================================================
// concatUint8Arrays Tests
// ============================================================================

describe('concatUint8Arrays', () => {
  it('concatenates multiple arrays', () => {
    const arr1 = new Uint8Array([1, 2, 3]);
    const arr2 = new Uint8Array([4, 5]);
    const arr3 = new Uint8Array([6, 7, 8, 9]);

    const result = concatUint8Arrays([arr1, arr2, arr3]);

    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(result.length).toBe(9);
  });

  it('handles single array', () => {
    const arr = new Uint8Array([1, 2, 3]);
    const result = concatUint8Arrays([arr]);
    expect(result).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('handles empty array input', () => {
    const result = concatUint8Arrays([]);
    expect(result).toEqual(new Uint8Array([]));
    expect(result.length).toBe(0);
  });

  it('handles arrays containing empty Uint8Arrays', () => {
    const arr1 = new Uint8Array([]);
    const arr2 = new Uint8Array([1, 2]);
    const arr3 = new Uint8Array([]);

    const result = concatUint8Arrays([arr1, arr2, arr3]);
    expect(result).toEqual(new Uint8Array([1, 2]));
  });

  it('preserves binary data integrity', () => {
    const arr1 = new Uint8Array([0x00, 0xff, 0x7f]);
    const arr2 = new Uint8Array([0x80, 0x01]);

    const result = concatUint8Arrays([arr1, arr2]);
    expect(result).toEqual(new Uint8Array([0x00, 0xff, 0x7f, 0x80, 0x01]));
  });
});

// ============================================================================
// readStreamToBuffer Tests
// ============================================================================

describe('readStreamToBuffer', () => {
  it('reads single-chunk stream', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });

    const result = await readStreamToBuffer(stream);
    expect(result).toEqual(data);
  });

  it('reads multi-chunk stream', async () => {
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
      new Uint8Array([6, 7, 8, 9]),
    ];

    let index = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(chunks[index++]);
        } else {
          controller.close();
        }
      },
    });

    const result = await readStreamToBuffer(stream);
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  });

  it('handles empty stream', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    const result = await readStreamToBuffer(stream);
    expect(result).toEqual(new Uint8Array([]));
    expect(result.length).toBe(0);
  });

  it('handles large data stream', async () => {
    const totalSize = 10000;
    const chunkSize = 1024;

    let bytesEmitted = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (bytesEmitted >= totalSize) {
          controller.close();
          return;
        }
        const remaining = totalSize - bytesEmitted;
        const size = Math.min(chunkSize, remaining);
        const chunk = new Uint8Array(size);
        for (let i = 0; i < size; i++) {
          chunk[i] = (bytesEmitted + i) % 256;
        }
        controller.enqueue(chunk);
        bytesEmitted += size;
      },
    });

    const result = await readStreamToBuffer(stream);

    expect(result.length).toBe(totalSize);
    // Verify content integrity
    for (let i = 0; i < totalSize; i++) {
      expect(result[i]).toBe(i % 256);
    }
  });
});
