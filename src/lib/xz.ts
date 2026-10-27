/**
 * XZ decompression for Cloudflare Workers, driving xzwasm's WASM exports directly.
 * Workers blocks the dynamic instantiation in xzwasm's JS wrapper, so the binary is extracted on
 * install and imported statically. The wrapper's stream also hands out views that later calls overwrite.
 */
import xzWasmModule from './xz-decompress.wasm';
import { concatUint8Arrays } from '../utils/streams';

interface XzExports {
  memory: WebAssembly.Memory;
  create_context(): number;
  destroy_context(context: number): void;
  supply_input(context: number, size: number): void;
  get_next_output(context: number): number;
}

const XZ_OK = 0;
const XZ_STREAM_END = 1;

const xz = new WebAssembly.Instance(xzWasmModule).exports as unknown as XzExports;

/**
 * Decompress a complete XZ stream, throwing if it is truncated or corrupt.
 * Runs synchronously, so concurrent callers never interleave on the shared WASM instance.
 */
export function decompressXz(input: Uint8Array): Uint8Array {
  const context = xz.create_context();
  try {
    const chunks: Uint8Array[] = [];
    let offset = 0;
    let result = XZ_OK;
    while (result === XZ_OK) {
      // The context is bufsize followed by xz_buf { in, in_pos, in_size, out, out_pos }.
      // Growing WASM memory detaches views, so take fresh ones after every call.
      const [bufSize, inPtr, inPos, inSize] = new Uint32Array(xz.memory.buffer, context, 4);
      if (inPos === inSize) {
        // Supplying zero bytes tells the decoder the input has ended.
        const next = input.subarray(offset, offset + bufSize);
        new Uint8Array(xz.memory.buffer, inPtr, next.length).set(next);
        xz.supply_input(context, next.length);
        offset += next.length;
      }
      result = xz.get_next_output(context);
      const fields = new Uint32Array(xz.memory.buffer, context, 6);
      // Copy the output out, since the next call reuses the buffer.
      chunks.push(new Uint8Array(xz.memory.buffer, fields[4], fields[5]).slice());
      fields[5] = 0;
    }
    if (result !== XZ_STREAM_END) {
      throw new Error(`XZ decompression failed with code ${result}`);
    }
    return concatUint8Arrays(chunks);
  } finally {
    xz.destroy_context(context);
  }
}
