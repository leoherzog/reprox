import type { TarEntry } from '../types';

/**
 * TAR Archive Parser
 *
 * Parses POSIX/UStar format tar archives.
 * Used to extract control file from control.tar.gz in .deb packages.
 *
 * TAR Format:
 * - Each file has a 512-byte header followed by data (rounded to 512 bytes)
 * - Header fields are mostly ASCII strings, null or space padded
 */

const TAR_BLOCK_SIZE = 512;
const textDecoder = new TextDecoder('utf-8');

/**
 * Parse a tar archive and extract file entries
 * Handles both old-style and UStar formats
 */
export function parseTar(buffer: ArrayBuffer): TarEntry[] {
  const view = new Uint8Array(buffer);
  const entries: TarEntry[] = [];

  let offset = 0;

  while (offset + TAR_BLOCK_SIZE <= buffer.byteLength) {
    // Check for end-of-archive marker (two zero blocks)
    const headerBlock = view.slice(offset, offset + TAR_BLOCK_SIZE);
    if (isZeroBlock(headerBlock)) {
      break;
    }

    // Parse header
    const name = extractTarString(headerBlock, 0, 100);
    const size = extractTarOctal(headerBlock, 124, 12);
    const typeFlag = String.fromCharCode(headerBlock[156]);

    // Skip entries that aren't regular files
    if (typeFlag === '5' || typeFlag === 'L' || typeFlag === 'x' || typeFlag === 'g') {
      // Directory, long name, extended header, or global extended header
      offset += TAR_BLOCK_SIZE + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
      continue;
    }

    // Handle prefix for UStar format (longer paths)
    const magic = textDecoder.decode(headerBlock.slice(257, 262));
    let fullName = name;
    if (magic === 'ustar') {
      const prefix = extractTarString(headerBlock, 345, 155);
      if (prefix) {
        fullName = prefix + '/' + name;
      }
    }

    // Clean up the name (remove leading ./)
    fullName = fullName.replace(/^\.\//, '');

    // Extract file data
    const dataStart = offset + TAR_BLOCK_SIZE;
    const dataEnd = dataStart + size;

    if (dataEnd <= buffer.byteLength) {
      const data = new Uint8Array(buffer.slice(dataStart, dataEnd));
      entries.push({
        name: fullName,
        size,
        data,
      });
    }

    // Move to next entry (data is padded to 512-byte boundary)
    const dataBlocks = Math.ceil(size / TAR_BLOCK_SIZE);
    offset += TAR_BLOCK_SIZE + dataBlocks * TAR_BLOCK_SIZE;
  }

  return entries;
}

/**
 * Extract a null/space-terminated string from tar header
 */
function extractTarString(header: Uint8Array, offset: number, length: number): string {
  const bytes = header.slice(offset, offset + length);
  let end = bytes.indexOf(0);
  if (end === -1) end = length;
  return textDecoder.decode(bytes.slice(0, end)).trim();
}

/**
 * Extract an octal number from tar header
 */
function extractTarOctal(header: Uint8Array, offset: number, length: number): number {
  const str = extractTarString(header, offset, length);
  if (!str) return 0;
  return parseInt(str, 8) || 0;
}

/**
 * Check if a block is all zeros (end-of-archive marker)
 */
function isZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}

/**
 * Find a file in tar entries by name pattern
 */
export function findTarEntry(entries: TarEntry[], pattern: RegExp | string): TarEntry | undefined {
  if (typeof pattern === 'string') {
    return entries.find(e => e.name === pattern || e.name.endsWith('/' + pattern));
  }
  return entries.find(e => pattern.test(e.name));
}
