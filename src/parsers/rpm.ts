import type { RpmHeaderData, RpmChangelogEntry } from '../types';

/**
 * RPM Package Parser
 *
 * Extracts metadata from .rpm packages using Range Requests.
 * Only fetches the header portion (typically < 100KB).
 *
 * RPM Format:
 * - Lead (96 bytes) - obsolete, kept for compatibility
 * - Signature header - signed checksums
 * - Header - package metadata (THIS IS WHAT WE PARSE)
 * - Payload - compressed cpio archive (ignored)
 */

const RPM_MAGIC = [0xed, 0xab, 0xee, 0xdb]; // RPM file magic
const HEADER_MAGIC = [0x8e, 0xad, 0xe8]; // Header section magic
const RPM_LEAD_SIZE = 96;
const HEADER_HEADER_SIZE = 16;

// RPM header tag IDs
const RPMTAG = {
  NAME: 1000,
  VERSION: 1001,
  RELEASE: 1002,
  EPOCH: 1003,
  SUMMARY: 1004,
  DESCRIPTION: 1005,
  BUILDTIME: 1006,
  BUILDHOST: 1007,
  SIZE: 1009,
  LICENSE: 1014,
  GROUP: 1016,
  URL: 1020,
  OS: 1021,
  ARCH: 1022,
  SOURCERPM: 1044,
  PROVIDENAME: 1047,
  REQUIRENAME: 1049,
  REQUIREVERSION: 1050,
  REQUIREFLAGS: 1048,
  CONFLICTNAME: 1054,
  OBSOLETENAME: 1090,
  VENDOR: 1011,
  PACKAGER: 1015,
  // File list tags
  BASENAMES: 1117,
  DIRNAMES: 1118,
  DIRINDEXES: 1116,
  // Changelog tags
  CHANGELOGTIME: 1080,
  CHANGELOGNAME: 1081,
  CHANGELOGTEXT: 1082,
} as const;

// RPM tag types
const RPM_TYPE = {
  NULL: 0,
  CHAR: 1,
  INT8: 2,
  INT16: 3,
  INT32: 4,
  INT64: 5,
  STRING: 6,
  BIN: 7,
  STRING_ARRAY: 8,
  I18NSTRING: 9,
} as const;

// Range request size for RPM (headers with file lists can be larger)
// Increase to 256KB to capture file lists and changelogs
const MIN_RANGE_SIZE = 262144; // 256KB

/**
 * Extract metadata from an RPM package URL using Range Request.
 */
export async function extractRpmMetadata(
  assetUrl: string,
  githubToken?: string
): Promise<RpmHeaderData> {
  const headers: HeadersInit = {
    Range: `bytes=0-${MIN_RANGE_SIZE - 1}`,
    Accept: 'application/octet-stream',
  };

  if (githubToken) {
    headers['Authorization'] = `token ${githubToken}`;
  }

  const response = await fetch(assetUrl, { headers });

  if (!response.ok && response.status !== 206) {
    throw new Error(`Failed to fetch .rpm header: ${response.status} ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  return parseRpmBuffer(buffer);
}

/**
 * Parse RPM buffer to extract header metadata
 */
export function parseRpmBuffer(buffer: ArrayBuffer): RpmHeaderData {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Check buffer has minimum required size
  if (bytes.length < RPM_LEAD_SIZE + HEADER_HEADER_SIZE) {
    throw new Error('Invalid RPM file: buffer too small');
  }

  // Verify RPM magic
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== RPM_MAGIC[i]) {
      throw new Error('Invalid RPM file: bad magic');
    }
  }

  // Skip lead (96 bytes)
  let offset = RPM_LEAD_SIZE;

  // Skip signature header
  offset = skipHeader(view, bytes, offset);

  // Align to 8-byte boundary after signature
  offset = Math.ceil(offset / 8) * 8;

  // Parse main header
  const headerData = parseHeader(view, bytes, offset);

  // Build file list from basenames, dirnames, and dirindexes
  const files = buildFileList(headerData);

  // Build changelog from time, name, and text arrays
  const changelog = buildChangelog(headerData);

  return {
    name: headerData[RPMTAG.NAME] as string || '',
    version: headerData[RPMTAG.VERSION] as string || '',
    release: headerData[RPMTAG.RELEASE] as string || '',
    epoch: headerData[RPMTAG.EPOCH] as number || 0,
    summary: headerData[RPMTAG.SUMMARY] as string || '',
    description: headerData[RPMTAG.DESCRIPTION] as string || '',
    arch: headerData[RPMTAG.ARCH] as string || 'x86_64',
    license: headerData[RPMTAG.LICENSE] as string || '',
    group: headerData[RPMTAG.GROUP] as string || '',
    url: headerData[RPMTAG.URL] as string || '',
    vendor: headerData[RPMTAG.VENDOR] as string || '',
    packager: headerData[RPMTAG.PACKAGER] as string || '',
    buildTime: headerData[RPMTAG.BUILDTIME] as number || 0,
    sourceRpm: headerData[RPMTAG.SOURCERPM] as string || '',
    requires: headerData[RPMTAG.REQUIRENAME] as string[] || [],
    provides: headerData[RPMTAG.PROVIDENAME] as string[] || [],
    conflicts: headerData[RPMTAG.CONFLICTNAME] as string[] || [],
    obsoletes: headerData[RPMTAG.OBSOLETENAME] as string[] || [],
    files,
    changelog,
  };
}

/**
 * Build file list from RPM header data
 */
function buildFileList(
  headerData: Record<number, string | number | string[] | number[]>
): string[] {
  const basenames = headerData[RPMTAG.BASENAMES] as string[] || [];
  const dirnames = headerData[RPMTAG.DIRNAMES] as string[] || [];
  const dirindexes = headerData[RPMTAG.DIRINDEXES] as number[] || [];

  if (basenames.length === 0) {
    return [];
  }

  const files: string[] = [];
  for (let i = 0; i < basenames.length; i++) {
    const dirIndex = dirindexes[i] || 0;
    const dirname = dirnames[dirIndex] || '/';
    files.push(dirname + basenames[i]);
  }

  return files;
}

/**
 * Build changelog from RPM header data
 */
function buildChangelog(
  headerData: Record<number, string | number | string[] | number[]>
): RpmChangelogEntry[] {
  const times = headerData[RPMTAG.CHANGELOGTIME] as number[] || [];
  const names = headerData[RPMTAG.CHANGELOGNAME] as string[] || [];
  const texts = headerData[RPMTAG.CHANGELOGTEXT] as string[] || [];

  const changelog: RpmChangelogEntry[] = [];

  // Limit to 10 most recent entries (changelogs can be very long)
  const count = Math.min(times.length, names.length, texts.length, 10);

  for (let i = 0; i < count; i++) {
    changelog.push({
      time: times[i] || 0,
      author: names[i] || '',
      text: texts[i] || '',
    });
  }

  return changelog;
}

/**
 * Skip over a header section, returning new offset
 */
function skipHeader(view: DataView, bytes: Uint8Array, offset: number): number {
  // Verify header magic
  if (bytes[offset] !== HEADER_MAGIC[0] ||
      bytes[offset + 1] !== HEADER_MAGIC[1] ||
      bytes[offset + 2] !== HEADER_MAGIC[2]) {
    throw new Error(`Invalid RPM header magic at offset ${offset}`);
  }

  // Header structure: magic(3) + version(1) + reserved(4) + nindex(4) + hsize(4)
  const nindex = view.getUint32(offset + 8, false); // big-endian
  const hsize = view.getUint32(offset + 12, false);

  // Skip: header header (16) + index entries (16 * nindex) + data (hsize)
  return offset + HEADER_HEADER_SIZE + (nindex * 16) + hsize;
}

/**
 * Parse header section and extract tag values
 */
function parseHeader(
  view: DataView,
  bytes: Uint8Array,
  offset: number
): Record<number, string | number | string[] | number[]> {
  // Verify header magic
  if (bytes[offset] !== HEADER_MAGIC[0] ||
      bytes[offset + 1] !== HEADER_MAGIC[1] ||
      bytes[offset + 2] !== HEADER_MAGIC[2]) {
    throw new Error(`Invalid RPM header magic at offset ${offset}`);
  }

  const nindex = view.getUint32(offset + 8, false);
  const hsize = view.getUint32(offset + 12, false);

  const indexStart = offset + HEADER_HEADER_SIZE;
  const dataStart = indexStart + (nindex * 16);

  const result: Record<number, string | number | string[] | number[]> = {};

  // Parse each index entry
  for (let i = 0; i < nindex; i++) {
    const entryOffset = indexStart + (i * 16);

    const tag = view.getUint32(entryOffset, false);
    const type = view.getUint32(entryOffset + 4, false);
    const dataOffset = view.getUint32(entryOffset + 8, false);
    const count = view.getUint32(entryOffset + 12, false);

    const valueOffset = dataStart + dataOffset;

    // Only parse tags we care about
    if (!Object.values(RPMTAG).includes(tag as typeof RPMTAG[keyof typeof RPMTAG])) {
      continue;
    }

    try {
      result[tag] = readTagValue(view, bytes, valueOffset, type, count);
    } catch {
      // Skip malformed tags
    }
  }

  return result;
}

/**
 * Read a tag value based on its type
 */
function readTagValue(
  view: DataView,
  bytes: Uint8Array,
  offset: number,
  type: number,
  count: number
): string | number | string[] | number[] {
  switch (type) {
    case RPM_TYPE.INT32:
      // Handle array of INT32 values (e.g., dirindexes, changelogtime)
      if (count > 1) {
        const ints: number[] = [];
        for (let i = 0; i < count; i++) {
          ints.push(view.getUint32(offset + (i * 4), false));
        }
        return ints;
      }
      return view.getUint32(offset, false);

    case RPM_TYPE.STRING:
    case RPM_TYPE.I18NSTRING:
      return readNullTerminatedString(bytes, offset);

    case RPM_TYPE.STRING_ARRAY: {
      const strings: string[] = [];
      let pos = offset;
      for (let i = 0; i < count; i++) {
        const str = readNullTerminatedString(bytes, pos);
        strings.push(str);
        pos += str.length + 1;
      }
      return strings;
    }

    default:
      return '';
  }
}

/**
 * Read null-terminated string from buffer
 */
function readNullTerminatedString(bytes: Uint8Array, offset: number): string {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) {
    end++;
  }
  const decoder = new TextDecoder('utf-8');
  return decoder.decode(bytes.slice(offset, end));
}

/**
 * Get RPM architecture from filename
 */
export function extractRpmArchFromFilename(filename: string): string {
  // RPM filenames: name-version-release.arch.rpm
  const match = filename.match(/\.([^.]+)\.rpm$/);
  if (match) {
    const arch = match[1];
    // Normalize architecture names
    if (arch === 'x86_64' || arch === 'amd64') return 'x86_64';
    if (arch === 'aarch64' || arch === 'arm64') return 'aarch64';
    if (arch === 'i686' || arch === 'i386') return 'i686';
    if (arch === 'noarch') return 'noarch';
    return arch;
  }
  return 'x86_64';
}
