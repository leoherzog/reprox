/**
 * Extracts the WASM binary from xzwasm package for static import in Cloudflare Workers.
 *
 * Workers requires static WASM imports, but xzwasm embeds WASM as base64 and uses
 * dynamic WebAssembly.instantiate() which Workers blocks. This script extracts the
 * WASM to a separate file that can be imported statically.
 *
 * Runs automatically via postinstall hook.
 */
const fs = require('fs');
const path = require('path');

const xzwasmPath = path.join(__dirname, '../node_modules/xzwasm/dist/package/xzwasm.js');
const outputPath = path.join(__dirname, '../src/lib/xz-decompress.wasm');

// Check if xzwasm is installed
if (!fs.existsSync(xzwasmPath)) {
  console.log('xzwasm not installed yet, skipping WASM extraction');
  process.exit(0);
}

// Read the xzwasm bundle
const jsFile = fs.readFileSync(xzwasmPath, 'utf8');

// Extract the base64-encoded WASM
const match = jsFile.match(/data:application\/wasm;base64,([A-Za-z0-9+/=]+)/);
if (!match) {
  console.error('Could not find WASM base64 in xzwasm package');
  process.exit(1);
}

// Decode and write the WASM file
const wasmBuffer = Buffer.from(match[1], 'base64');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, wasmBuffer);

console.log(`Extracted xz-decompress.wasm (${wasmBuffer.length} bytes)`);
