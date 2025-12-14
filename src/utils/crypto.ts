/**
 * Cryptographic utilities for Repoxy
 *
 * Uses Web Crypto API (crypto.subtle) available in Cloudflare Workers.
 * Note: MD5 is NOT supported by Web Crypto API.
 */

/**
 * Calculate SHA256 hash of data (string, Uint8Array, or ArrayBuffer)
 */
export async function sha256(data: string | Uint8Array | ArrayBuffer): Promise<string> {
  let buffer: BufferSource;

  if (typeof data === 'string') {
    buffer = new TextEncoder().encode(data);
  } else {
    buffer = data;
  }

  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return bufferToHex(hashBuffer);
}

/**
 * Calculate SHA1 hash of data
 * Note: SHA1 is deprecated for security but still used in some repo formats
 */
export async function sha1(data: string | Uint8Array | ArrayBuffer): Promise<string> {
  let buffer: BufferSource;

  if (typeof data === 'string') {
    buffer = new TextEncoder().encode(data);
  } else {
    buffer = data;
  }

  const hashBuffer = await crypto.subtle.digest('SHA-1', buffer);
  return bufferToHex(hashBuffer);
}

/**
 * Convert ArrayBuffer to lowercase hex string
 */
function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compress data with gzip using native CompressionStream
 */
export async function gzipCompress(data: string | Uint8Array): Promise<Uint8Array> {
  const input = typeof data === 'string' ? new TextEncoder().encode(data) : data;

  const cs = new CompressionStream('gzip');
  const blob = new Blob([input]);
  const stream = blob.stream().pipeThrough(cs);

  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  return concatUint8Arrays(chunks);
}

/**
 * Decompress gzip data using native DecompressionStream
 */
export async function gzipDecompress(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const blob = new Blob([data]);
  const stream = blob.stream().pipeThrough(ds);

  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  return concatUint8Arrays(chunks);
}

/**
 * Concatenate multiple Uint8Arrays into one
 */
function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((acc, arr) => acc + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
