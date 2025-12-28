/**
 * Cryptographic utilities for Reprox
 *
 * Uses Web Crypto API (crypto.subtle) available in Cloudflare Workers.
 * Note: MD5 is NOT supported by Web Crypto API.
 */

import { readStreamToBuffer } from './streams';

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

  return readStreamToBuffer(stream);
}
