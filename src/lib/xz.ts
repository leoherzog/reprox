/**
 * XZ decompression wrapper for Cloudflare Workers
 *
 * Uses xzwasm library but patches it with a statically-imported WASM module
 * (required by Workers instead of dynamic instantiation).
 */
import { XzReadableStream } from 'xzwasm';
import xzWasmModule from './xz-decompress.wasm';
import { readStreamToBuffer } from '../utils/streams';

// Patch the library with our statically-imported WASM module
// This bypasses the dynamic WebAssembly.instantiate that doesn't work in Workers
let initialized = false;
let initPromise: Promise<void> | null = null;

async function ensureInitialized(): Promise<void> {
  if (initialized) return;

  // Return existing promise if already initializing (prevents race condition)
  if (initPromise) return initPromise;

  // Create and store initialization promise
  initPromise = (async () => {
    // Instantiate the statically-imported WASM module
    const instance = await WebAssembly.instantiate(xzWasmModule, {});

    // Patch the XzReadableStream class with our pre-instantiated module
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (XzReadableStream as any)._moduleInstance = instance;

    initialized = true;
  })();

  return initPromise;
}

/**
 * Decompress XZ-compressed data using the xzwasm library.
 *
 * @param compressedData - The XZ-compressed input data
 * @returns The decompressed data
 */
export async function decompressXz(compressedData: Uint8Array): Promise<Uint8Array> {
  await ensureInitialized();

  const compressedStream = new Blob([compressedData]).stream();
  const decompressedStream = new XzReadableStream(compressedStream);

  return readStreamToBuffer(decompressedStream);
}
