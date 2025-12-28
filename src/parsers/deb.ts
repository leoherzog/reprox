import type { DebianControlData } from '../types';
import { parseArHeaders, extractArFile, findArEntry } from './ar';
import { parseTar, findTarEntry } from './tar';
import { decompress as decompressZstd } from 'fzstd';
import { XzReadableStream } from 'xz-decompress';
import { readStreamToBuffer } from '../utils/streams';

/**
 * Debian Package Parser
 *
 * Extracts control metadata from .deb packages using Range Requests.
 * Only fetches the first ~64KB of the file to extract headers.
 *
 * .deb files are AR archives containing:
 * - debian-binary (version string)
 * - control.tar.gz (package metadata) - THIS IS WHAT WE PARSE
 * - data.tar.gz (actual files) - ignored
 */

/**
 * Parse a .deb file buffer (or partial buffer) to extract control data.
 * Handles gzip-compressed control archives (most common).
 */
export async function parseDebBufferAsync(buffer: ArrayBuffer): Promise<DebianControlData> {
  // Parse AR archive structure
  const arEntries = parseArHeaders(buffer);

  // Find control archive (could be control.tar.gz, control.tar.xz, or control.tar.zst)
  const controlEntry = findArEntry(arEntries, /^control\.tar/);
  if (!controlEntry) {
    throw new Error('No control archive found in .deb package');
  }

  // Extract control archive data
  const controlArchiveData = extractArFile(buffer, controlEntry);

  // Decompress based on compression type
  let controlTarData: Uint8Array;
  if (controlEntry.name.endsWith('.gz')) {
    controlTarData = await decompressGzipAsync(controlArchiveData);
  } else if (controlEntry.name.endsWith('.xz')) {
    controlTarData = await decompressXzAsync(controlArchiveData);
  } else if (controlEntry.name.endsWith('.zst')) {
    controlTarData = decompressZstdData(controlArchiveData);
  } else if (controlEntry.name === 'control.tar') {
    controlTarData = controlArchiveData; // Uncompressed
  } else {
    throw new Error(`Unknown control archive compression: ${controlEntry.name}`);
  }

  // Parse tar and find control file
  const tarEntries = parseTar(controlTarData.buffer as ArrayBuffer);
  const controlFile = findTarEntry(tarEntries, 'control');

  if (!controlFile) {
    throw new Error('No control file found in control archive');
  }

  // Parse control file content
  const controlText = new TextDecoder('utf-8').decode(controlFile.data);
  return parseControlFile(controlText);
}

/**
 * Decompress gzip data using native DecompressionStream API.
 * Available in Cloudflare Workers runtime.
 */
async function decompressGzipAsync(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const blob = new Blob([data]);
  const stream = blob.stream().pipeThrough(ds);

  return readStreamToBuffer(stream);
}

/**
 * Decompress XZ data using xz-decompress library (WASM-based).
 * Uses streaming API similar to DecompressionStream.
 */
async function decompressXzAsync(data: Uint8Array): Promise<Uint8Array> {
  const compressedStream = new Blob([data]).stream();
  const decompressedStream = new XzReadableStream(compressedStream);

  return readStreamToBuffer(decompressedStream);
}

/**
 * Decompress Zstandard data using fzstd library.
 */
function decompressZstdData(data: Uint8Array): Uint8Array {
  return decompressZstd(data);
}

/**
 * Parse Debian control file format.
 * Format: Field: Value (with continuation lines starting with space/tab)
 *
 * Example:
 *   Package: hello
 *   Version: 1.0.0
 *   Description: A greeting program
 *    This is a continuation line.
 */
export function parseControlFile(content: string): DebianControlData {
  const fields: Record<string, string> = {};
  const lines = content.split('\n');

  let currentField = '';
  let currentValue = '';

  for (const line of lines) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      // Continuation line
      if (currentField) {
        currentValue += '\n' + line.slice(1);
      }
    } else if (line.includes(':')) {
      // Save previous field
      if (currentField) {
        fields[currentField.toLowerCase()] = currentValue.trim();
      }

      // Parse new field
      const colonIndex = line.indexOf(':');
      currentField = line.slice(0, colonIndex);
      currentValue = line.slice(colonIndex + 1);
    }
  }

  // Save last field
  if (currentField) {
    fields[currentField.toLowerCase()] = currentValue.trim();
  }

  return {
    package: fields['package'] || '',
    version: fields['version'] || '',
    architecture: fields['architecture'] || 'all',
    maintainer: fields['maintainer'] || '',
    installedSize: parseInt(fields['installed-size'] || '0', 10),
    depends: fields['depends'] || '',
    recommends: fields['recommends'] || '',
    suggests: fields['suggests'] || '',
    conflicts: fields['conflicts'] || '',
    replaces: fields['replaces'] || '',
    provides: fields['provides'] || '',
    section: fields['section'] || '',
    priority: fields['priority'] || 'optional',
    homepage: fields['homepage'] || '',
    description: fields['description'] || '',
  };
}
