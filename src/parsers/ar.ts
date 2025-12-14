import type { ArEntry } from '../types';

/**
 * AR Archive Parser
 *
 * Debian .deb files are AR archives containing:
 * - debian-binary (version string)
 * - control.tar.gz or control.tar.xz (package metadata)
 * - data.tar.gz or data.tar.xz (actual files)
 *
 * AR Format:
 * - Magic: "!<arch>\n" (8 bytes)
 * - File entries, each with:
 *   - Name: 16 bytes (space-padded)
 *   - Timestamp: 12 bytes (decimal)
 *   - Owner ID: 6 bytes (decimal)
 *   - Group ID: 6 bytes (decimal)
 *   - Mode: 8 bytes (octal)
 *   - Size: 10 bytes (decimal)
 *   - Magic: "`\n" (2 bytes)
 *   - Data: size bytes (padded to even boundary)
 */

const AR_MAGIC = '!<arch>\n';
const AR_HEADER_SIZE = 60;

/**
 * Parse AR archive headers from a buffer
 * Returns metadata about files without extracting their full content
 */
export function parseArHeaders(buffer: ArrayBuffer): ArEntry[] {
  const view = new DataView(buffer);
  const decoder = new TextDecoder('ascii');
  const entries: ArEntry[] = [];

  // Verify AR magic
  const magic = decoder.decode(new Uint8Array(buffer, 0, 8));
  if (magic !== AR_MAGIC) {
    throw new Error(`Invalid AR archive: expected magic "${AR_MAGIC}", got "${magic}"`);
  }

  let offset = 8; // Skip magic

  while (offset + AR_HEADER_SIZE <= buffer.byteLength) {
    // Parse header fields
    const headerBytes = new Uint8Array(buffer, offset, AR_HEADER_SIZE);
    const header = decoder.decode(headerBytes);

    // Extract and trim fields
    let name = header.slice(0, 16).trim();
    const timestamp = parseInt(header.slice(16, 28).trim(), 10);
    const ownerId = parseInt(header.slice(28, 34).trim(), 10);
    const groupId = parseInt(header.slice(34, 40).trim(), 10);
    const mode = parseInt(header.slice(40, 48).trim(), 8);
    const size = parseInt(header.slice(48, 58).trim(), 10);
    const fileMagic = header.slice(58, 60);

    // Verify file header magic
    if (fileMagic !== '`\n') {
      throw new Error(`Invalid AR file header at offset ${offset}: bad magic "${fileMagic}"`);
    }

    // Handle BSD-style extended filenames (not common in .deb but good to handle)
    if (name.startsWith('#1/')) {
      const nameLen = parseInt(name.slice(3), 10);
      const extendedName = decoder.decode(
        new Uint8Array(buffer, offset + AR_HEADER_SIZE, nameLen)
      ).replace(/\0+$/, '');
      name = extendedName;
    }

    // Handle GNU-style extended filenames (filename ends with /)
    if (name.endsWith('/')) {
      name = name.slice(0, -1);
    }

    entries.push({
      name,
      timestamp,
      ownerId,
      groupId,
      mode,
      size,
      offset: offset + AR_HEADER_SIZE,
    });

    // Move to next entry (aligned to even boundary)
    offset += AR_HEADER_SIZE + size;
    if (offset % 2 !== 0) {
      offset++;
    }
  }

  return entries;
}

/**
 * Extract a file's data from an AR archive
 */
export function extractArFile(buffer: ArrayBuffer, entry: ArEntry): Uint8Array {
  if (entry.offset + entry.size > buffer.byteLength) {
    throw new Error(
      `Cannot extract "${entry.name}": data extends beyond buffer (need ${entry.offset + entry.size}, have ${buffer.byteLength})`
    );
  }
  return new Uint8Array(buffer, entry.offset, entry.size);
}

/**
 * Find a file in AR entries by name pattern
 */
export function findArEntry(entries: ArEntry[], pattern: RegExp | string): ArEntry | undefined {
  if (typeof pattern === 'string') {
    return entries.find(e => e.name === pattern);
  }
  return entries.find(e => pattern.test(e.name));
}
