import type { DebianControlData } from '../types';
import { parseArHeaders, extractArFile, findArEntry } from './ar';
import { parseTar, findTarEntry } from './tar';

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

// Minimum bytes needed to extract control data (usually ~20KB is enough)
const MIN_RANGE_SIZE = 65536; // 64KB

/**
 * Extract control metadata from a .deb package URL using Range Request.
 * This is the "Blind Parser" - fetches only the first 64KB header portion.
 */
export async function extractDebMetadata(
  assetUrl: string,
  githubToken?: string
): Promise<DebianControlData> {
  const headers: HeadersInit = {
    Range: `bytes=0-${MIN_RANGE_SIZE - 1}`,
    Accept: 'application/octet-stream',
  };

  if (githubToken) {
    headers['Authorization'] = `token ${githubToken}`;
  }

  const response = await fetch(assetUrl, { headers });

  if (!response.ok && response.status !== 206) {
    throw new Error(`Failed to fetch .deb header: ${response.status} ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  return parseDebBufferAsync(buffer);
}

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
    // XZ is not natively supported in Workers - would need a library like lzma-native
    throw new Error(
      'XZ-compressed .deb packages are not supported. ' +
      'Most packages use gzip compression which is supported.'
    );
  } else if (controlEntry.name.endsWith('.zst')) {
    throw new Error(
      'Zstandard-compressed .deb packages are not supported. ' +
      'Most packages use gzip compression which is supported.'
    );
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

  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  // Concatenate chunks into single buffer
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
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
