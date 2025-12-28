import { describe, it, expect } from 'vitest';
import { sha256, gzipCompress } from '../src/utils/crypto';

describe('sha256', () => {
  it('hashes an empty string', async () => {
    const hash = await sha256('');
    // Known SHA256 of empty string
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes a simple string', async () => {
    const hash = await sha256('hello');
    // Known SHA256 of "hello"
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('hashes a Uint8Array', async () => {
    const data = new TextEncoder().encode('hello');
    const hash = await sha256(data);
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('hashes an ArrayBuffer', async () => {
    const data = new TextEncoder().encode('hello').buffer;
    const hash = await sha256(data);
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('produces lowercase hex output', async () => {
    const hash = await sha256('test');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hashes for different inputs', async () => {
    const hash1 = await sha256('hello');
    const hash2 = await sha256('world');
    expect(hash1).not.toBe(hash2);
  });
});

describe('gzipCompress', () => {
  it('compresses a string', async () => {
    const input = 'Hello, World!';
    const compressed = await gzipCompress(input);

    // Gzip magic bytes
    expect(compressed[0]).toBe(0x1f);
    expect(compressed[1]).toBe(0x8b);
  });

  it('compresses a Uint8Array', async () => {
    const input = new TextEncoder().encode('Hello, World!');
    const compressed = await gzipCompress(input);

    expect(compressed[0]).toBe(0x1f);
    expect(compressed[1]).toBe(0x8b);
  });

  it('compresses empty input', async () => {
    const compressed = await gzipCompress('');

    expect(compressed[0]).toBe(0x1f);
    expect(compressed[1]).toBe(0x8b);
  });

  it('produces smaller output for repetitive data', async () => {
    const input = 'a'.repeat(1000);
    const compressed = await gzipCompress(input);

    // Repetitive data should compress well
    expect(compressed.length).toBeLessThan(input.length);
  });

  it('can be decompressed back to original', async () => {
    const input = 'The quick brown fox jumps over the lazy dog';
    const compressed = await gzipCompress(input);

    // Decompress using DecompressionStream
    const ds = new DecompressionStream('gzip');
    const blob = new Blob([compressed]);
    const stream = blob.stream().pipeThrough(ds);
    const reader = stream.getReader();

    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const decompressed = new TextDecoder().decode(
      chunks.reduce((acc, chunk) => {
        const result = new Uint8Array(acc.length + chunk.length);
        result.set(acc);
        result.set(chunk, acc.length);
        return result;
      }, new Uint8Array(0))
    );

    expect(decompressed).toBe(input);
  });
});
