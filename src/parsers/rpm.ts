import type { RpmHeaderData, RpmChangelogEntry } from '../types';

/**
 * Thrown when the declared main-header size exceeds the buffer returned by
 * the range request. Callers can catch this specifically and retry with a
 * larger range rather than silently dropping the package.
 */
export class RpmHeaderTruncatedError extends Error {
  readonly required: number;
  readonly available: number;
  constructor(required: number, available: number) {
    super(`RPM header truncated: need ${required} bytes, have ${available}`);
    this.name = 'RpmHeaderTruncatedError';
    this.required = required;
    this.available = available;
  }
}

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
  CONFLICTVERSION: 1055,
  CONFLICTFLAGS: 1053,
  OBSOLETENAME: 1090,
  OBSOLETEFLAGS: 1114,
  OBSOLETEVERSION: 1115,
  PROVIDEFLAGS: 1112,
  PROVIDEVERSION: 1113,
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

/**
 * Parse a STRING_ARRAY from RPM header data.
 * Handles UTF-8 encoding correctly by advancing by actual byte count,
 * not JavaScript string length (which counts UTF-16 code units).
 *
 * @param bytes - The byte array containing the strings
 * @param offset - Starting offset in the byte array
 * @param count - Number of strings to extract
 * @returns Array of decoded strings
 */
export function parseStringArray(bytes: Uint8Array, offset: number, count: number): string[] {
  const strings: string[] = [];
  let pos = offset;
  for (let i = 0; i < count; i++) {
    // Find null terminator by scanning bytes directly
    let end = pos;
    while (end < bytes.length && bytes[end] !== 0) {
      end++;
    }
    const str = new TextDecoder('utf-8').decode(bytes.slice(pos, end));
    strings.push(str);
    pos = end + 1; // Advance by actual byte count
  }
  return strings;
}

/**
 * Normalize a parsed header value to a string array.
 * readTagValue returns string for count=1 STRING_ARRAY, string[] for count>1.
 */
function normalizeToStringArray(value: string | number | string[] | number[] | undefined): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map(v => String(v));
  const s = String(value);
  return s ? [s] : [];
}

/**
 * Normalize a parsed header value to a number array.
 * readTagValue returns number for count=1 INT32, number[] for count>1.
 */
function normalizeToNumberArray(value: string | number | string[] | number[] | undefined): number[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map(v => Number(v));
  return [Number(value)];
}

// Default range request size for RPM headers (file lists can push past this)
export const RPM_DEFAULT_RANGE_SIZE = 262144; // 256KB

/**
 * Extract metadata from an RPM package URL using Range Request.
 * The caller may override `rangeSize` to retry with a larger window when the
 * parser reports truncation (see RpmHeaderTruncatedError).
 */
export async function extractRpmMetadata(
  assetUrl: string,
  githubToken?: string,
  rangeSize: number = RPM_DEFAULT_RANGE_SIZE
): Promise<RpmHeaderData> {
  const headers: HeadersInit = {
    Range: `bytes=0-${rangeSize - 1}`,
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

  // Subset retained for primary.xml <format><file> emission.
  const primaryFiles = files.filter(isPrimaryFile);

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
    installedSize: headerData[RPMTAG.SIZE] as number || 0,
    requires: normalizeToStringArray(headerData[RPMTAG.REQUIRENAME]),
    requireVersions: normalizeToStringArray(headerData[RPMTAG.REQUIREVERSION]),
    requireFlags: normalizeToNumberArray(headerData[RPMTAG.REQUIREFLAGS]),
    provides: normalizeToStringArray(headerData[RPMTAG.PROVIDENAME]),
    provideVersions: normalizeToStringArray(headerData[RPMTAG.PROVIDEVERSION]),
    provideFlags: normalizeToNumberArray(headerData[RPMTAG.PROVIDEFLAGS]),
    conflicts: normalizeToStringArray(headerData[RPMTAG.CONFLICTNAME]),
    conflictVersions: normalizeToStringArray(headerData[RPMTAG.CONFLICTVERSION]),
    conflictFlags: normalizeToNumberArray(headerData[RPMTAG.CONFLICTFLAGS]),
    obsoletes: normalizeToStringArray(headerData[RPMTAG.OBSOLETENAME]),
    obsoleteVersions: normalizeToStringArray(headerData[RPMTAG.OBSOLETEVERSION]),
    obsoleteFlags: normalizeToNumberArray(headerData[RPMTAG.OBSOLETEFLAGS]),
    files,
    primaryFiles,
    changelog,
  };
}

/**
 * createrepo_c's primary-metadata file filter: paths under these prefixes (or
 * the exact filenames listed) are emitted in primary.xml <format><file> so DNF
 * can resolve file-based Requires without reading filelists.xml.
 *
 * Ref: createrepo_c's primary_files[] in src/misc.c. Config-file detection
 * (RPMFILEFLAGS with RPMFILE_CONFIG) is not implemented here — the prefix list
 * is what DNF needs for the common "Requires: /usr/bin/foo" pattern.
 */
const PRIMARY_FILE_PREFIXES = [
  '/etc/',
  '/bin/',
  '/sbin/',
  '/lib/',
  '/lib64/',
  '/usr/bin/',
  '/usr/sbin/',
  '/usr/lib/',
  '/usr/lib64/',
  '/usr/libexec/',
  '/usr/games/',
  '/usr/share/dict/',
];
const PRIMARY_FILE_EXACT = [
  '/usr/share/magic.mime',
  '/usr/share/magic',
];

function isPrimaryFile(path: string): boolean {
  if (PRIMARY_FILE_EXACT.includes(path)) return true;
  for (const p of PRIMARY_FILE_PREFIXES) {
    if (path.startsWith(p)) return true;
  }
  return false;
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
    const dirIndex = dirindexes[i] ?? 0;
    // Bounds check to prevent accessing undefined directory
    const dirname = (dirIndex >= 0 && dirIndex < dirnames.length)
      ? dirnames[dirIndex]
      : '/';
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
  const headerEnd = dataStart + hsize;

  // The range request may not have fetched the full header. Surface this
  // distinctly so callers can retry with a larger range instead of dropping
  // the package on a generic RangeError from an OOB DataView read below.
  if (headerEnd > bytes.length) {
    throw new RpmHeaderTruncatedError(headerEnd, bytes.length);
  }

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

    case RPM_TYPE.STRING_ARRAY:
      return parseStringArray(bytes, offset, count);

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

