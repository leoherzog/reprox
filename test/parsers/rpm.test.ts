import { describe, it, expect } from 'vitest';
import { parseRpmBuffer, extractRpmArchFromFilename } from '../../src/parsers/rpm';

// ============================================================================
// Test Helpers - RPM Buffer Construction
// ============================================================================

const RPM_MAGIC = [0xed, 0xab, 0xee, 0xdb];
const HEADER_MAGIC = [0x8e, 0xad, 0xe8];

/**
 * Create a minimal RPM lead (96 bytes)
 */
function createRpmLead(): Uint8Array {
  const lead = new Uint8Array(96);
  // Magic
  lead[0] = RPM_MAGIC[0];
  lead[1] = RPM_MAGIC[1];
  lead[2] = RPM_MAGIC[2];
  lead[3] = RPM_MAGIC[3];
  // Version 3.0
  lead[4] = 3;
  lead[5] = 0;
  // Type: binary
  lead[6] = 0;
  lead[7] = 0;
  // Rest is zeros (name, os, signature type, reserved)
  return lead;
}

/**
 * Create a minimal RPM header section
 */
function createRpmHeader(
  tags: { tag: number; type: number; value: string | number | string[] | number[] }[]
): Uint8Array {
  // Calculate sizes
  let dataSize = 0;
  const indexEntries: { tag: number; type: number; offset: number; count: number }[] = [];

  for (const { tag, type, value } of tags) {
    const offset = dataSize;
    let count = 1;

    if (type === 6) {
      // STRING: null-terminated
      const str = value as string;
      dataSize += str.length + 1;
    } else if (type === 8) {
      // STRING_ARRAY
      const strs = value as string[];
      count = strs.length;
      for (const s of strs) {
        dataSize += s.length + 1;
      }
    } else if (type === 4) {
      // INT32
      if (Array.isArray(value)) {
        count = value.length;
        dataSize += 4 * count;
      } else {
        dataSize += 4;
      }
    }

    indexEntries.push({ tag, type, offset, count });
  }

  // Create header
  const nindex = indexEntries.length;
  const headerSize = 16 + (nindex * 16) + dataSize;
  const header = new Uint8Array(headerSize);
  const view = new DataView(header.buffer);

  // Header magic
  header[0] = HEADER_MAGIC[0];
  header[1] = HEADER_MAGIC[1];
  header[2] = HEADER_MAGIC[2];
  header[3] = 1; // version

  // Reserved (4 bytes) - zeros

  // Number of index entries (big-endian)
  view.setUint32(8, nindex, false);

  // Size of data section (big-endian)
  view.setUint32(12, dataSize, false);

  // Write index entries
  for (let i = 0; i < nindex; i++) {
    const entry = indexEntries[i];
    const entryOffset = 16 + (i * 16);
    view.setUint32(entryOffset, entry.tag, false);
    view.setUint32(entryOffset + 4, entry.type, false);
    view.setUint32(entryOffset + 8, entry.offset, false);
    view.setUint32(entryOffset + 12, entry.count, false);
  }

  // Write data section
  const dataStart = 16 + (nindex * 16);
  let dataOffset = 0;

  for (const { type, value } of tags) {
    if (type === 6) {
      // STRING
      const str = value as string;
      const encoded = new TextEncoder().encode(str);
      header.set(encoded, dataStart + dataOffset);
      dataOffset += str.length + 1;
    } else if (type === 8) {
      // STRING_ARRAY
      const strs = value as string[];
      for (const s of strs) {
        const encoded = new TextEncoder().encode(s);
        header.set(encoded, dataStart + dataOffset);
        dataOffset += s.length + 1;
      }
    } else if (type === 4) {
      // INT32
      if (Array.isArray(value)) {
        for (const v of value) {
          view.setUint32(dataStart + dataOffset, v as number, false);
          dataOffset += 4;
        }
      } else {
        view.setUint32(dataStart + dataOffset, value as number, false);
        dataOffset += 4;
      }
    }
  }

  return header;
}

/**
 * Create a complete minimal RPM buffer
 */
function createMinimalRpm(
  name: string,
  version: string,
  release: string,
  arch: string
): ArrayBuffer {
  const lead = createRpmLead();

  // Signature header (minimal)
  const sigHeader = createRpmHeader([]);

  // Main header with basic tags
  const mainHeader = createRpmHeader([
    { tag: 1000, type: 6, value: name },      // NAME
    { tag: 1001, type: 6, value: version },   // VERSION
    { tag: 1002, type: 6, value: release },   // RELEASE
    { tag: 1022, type: 6, value: arch },      // ARCH
    { tag: 1004, type: 6, value: 'Test package summary' }, // SUMMARY
    { tag: 1005, type: 6, value: 'Test package description' }, // DESCRIPTION
  ]);

  // Align signature header to 8-byte boundary
  const sigPadding = (8 - (sigHeader.length % 8)) % 8;
  const totalSize = lead.length + sigHeader.length + sigPadding + mainHeader.length;

  const buffer = new ArrayBuffer(totalSize);
  const view = new Uint8Array(buffer);
  let offset = 0;

  view.set(lead, offset);
  offset += lead.length;

  view.set(sigHeader, offset);
  offset += sigHeader.length + sigPadding;

  view.set(mainHeader, offset);

  return buffer;
}

// ============================================================================
// extractRpmArchFromFilename Tests
// ============================================================================

describe('extractRpmArchFromFilename', () => {
  describe('x86_64 architecture', () => {
    it('detects x86_64', () => {
      expect(extractRpmArchFromFilename('package-1.0.0-1.x86_64.rpm')).toBe('x86_64');
    });

    it('detects amd64 and normalizes to x86_64', () => {
      expect(extractRpmArchFromFilename('package-1.0.0-1.amd64.rpm')).toBe('x86_64');
    });
  });

  describe('aarch64 architecture', () => {
    it('detects aarch64', () => {
      expect(extractRpmArchFromFilename('package-1.0.0-1.aarch64.rpm')).toBe('aarch64');
    });

    it('detects arm64 and normalizes to aarch64', () => {
      expect(extractRpmArchFromFilename('package-1.0.0-1.arm64.rpm')).toBe('aarch64');
    });
  });

  describe('i686 architecture', () => {
    it('detects i686', () => {
      expect(extractRpmArchFromFilename('package-1.0.0-1.i686.rpm')).toBe('i686');
    });

    it('detects i386 and normalizes to i686', () => {
      expect(extractRpmArchFromFilename('package-1.0.0-1.i386.rpm')).toBe('i686');
    });
  });

  describe('noarch architecture', () => {
    it('detects noarch', () => {
      expect(extractRpmArchFromFilename('package-1.0.0-1.noarch.rpm')).toBe('noarch');
    });
  });

  describe('default behavior', () => {
    it('defaults to x86_64 when no dot-separated segment before .rpm', () => {
      expect(extractRpmArchFromFilename('package.rpm')).toBe('x86_64');
    });

    it('returns whatever segment precedes .rpm (may not be arch)', () => {
      // Note: version numbers like 1.0.0 will match the last segment
      // Real RPM filenames should have arch before .rpm
      expect(extractRpmArchFromFilename('package-1.0.0.rpm')).toBe('0');
    });
  });

  describe('real-world filenames', () => {
    it('handles go-hass-agent RPM', () => {
      expect(extractRpmArchFromFilename('go-hass-agent-11.2.0-1.x86_64.rpm')).toBe('x86_64');
      expect(extractRpmArchFromFilename('go-hass-agent-11.2.0-1.aarch64.rpm')).toBe('aarch64');
    });

    it('handles obsidian RPM', () => {
      expect(extractRpmArchFromFilename('obsidian-1.5.12-1.x86_64.rpm')).toBe('x86_64');
    });

    it('handles localsend RPM', () => {
      expect(extractRpmArchFromFilename('LocalSend-1.14.0-1.linux.x86_64.rpm')).toBe('x86_64');
    });

    it('handles Fedora-style release strings', () => {
      expect(extractRpmArchFromFilename('package-1.2.3-4.fc39.x86_64.rpm')).toBe('x86_64');
      expect(extractRpmArchFromFilename('package-1.2.3-4.el9.aarch64.rpm')).toBe('aarch64');
    });
  });
});

// ============================================================================
// parseRpmBuffer Tests
// ============================================================================

describe('parseRpmBuffer', () => {
  it('parses minimal RPM with basic metadata', () => {
    const buffer = createMinimalRpm('test-pkg', '1.0.0', '1', 'x86_64');
    const result = parseRpmBuffer(buffer);

    expect(result.name).toBe('test-pkg');
    expect(result.version).toBe('1.0.0');
    expect(result.release).toBe('1');
    expect(result.arch).toBe('x86_64');
  });

  it('extracts summary and description', () => {
    const buffer = createMinimalRpm('test', '1.0', '1', 'x86_64');
    const result = parseRpmBuffer(buffer);

    expect(result.summary).toBe('Test package summary');
    expect(result.description).toBe('Test package description');
  });

  it('throws on invalid magic', () => {
    const buffer = new ArrayBuffer(200);
    const view = new Uint8Array(buffer);
    view[0] = 0x00; // Invalid magic

    expect(() => parseRpmBuffer(buffer)).toThrow('Invalid RPM file: bad magic');
  });

  it('throws on buffer too small', () => {
    const buffer = new ArrayBuffer(50); // Too small

    expect(() => parseRpmBuffer(buffer)).toThrow('Invalid RPM file: buffer too small');
  });

  it('provides default values for missing fields', () => {
    const lead = createRpmLead();
    const sigHeader = createRpmHeader([]);
    const mainHeader = createRpmHeader([
      { tag: 1000, type: 6, value: 'minimal' },
      { tag: 1001, type: 6, value: '1.0' },
      { tag: 1002, type: 6, value: '1' },
    ]);

    const sigPadding = (8 - (sigHeader.length % 8)) % 8;
    const totalSize = lead.length + sigHeader.length + sigPadding + mainHeader.length;

    const buffer = new ArrayBuffer(totalSize);
    const view = new Uint8Array(buffer);
    let offset = 0;

    view.set(lead, offset);
    offset += lead.length;
    view.set(sigHeader, offset);
    offset += sigHeader.length + sigPadding;
    view.set(mainHeader, offset);

    const result = parseRpmBuffer(buffer);

    expect(result.name).toBe('minimal');
    expect(result.epoch).toBe(0);
    expect(result.license).toBe('');
    expect(result.url).toBe('');
    expect(result.requires).toEqual([]);
    expect(result.provides).toEqual([]);
    expect(result.files).toEqual([]);
    expect(result.changelog).toEqual([]);
  });
});
