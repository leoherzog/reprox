import { describe, it, expect } from 'vitest';
import { parseControlFile, parseDebBufferAsync } from '../src/parsers/deb';
import { parseArHeaders, extractArFile, findArEntry } from '../src/parsers/ar';
import { parseTar, findTarEntry } from '../src/parsers/tar';
import { gzipCompress } from '../src/utils/crypto';

// ============================================================================
// Test Helpers - AR Archive Construction
// ============================================================================

/**
 * Create an AR archive in memory with the given files
 */
function createArArchive(files: { name: string; content: Uint8Array }[]): ArrayBuffer {
  const encoder = new TextEncoder();
  const magic = encoder.encode('!<arch>\n');

  // Calculate total size
  let totalSize = magic.length;
  for (const file of files) {
    totalSize += 60; // header
    totalSize += file.content.length;
    if (file.content.length % 2 !== 0) totalSize++; // padding
  }

  const buffer = new ArrayBuffer(totalSize);
  const view = new Uint8Array(buffer);
  let offset = 0;

  // Write magic
  view.set(magic, offset);
  offset += magic.length;

  // Write each file
  for (const file of files) {
    // Construct header (60 bytes total)
    const name = (file.name + '/').padEnd(16, ' ');
    const timestamp = '0           '; // 12 bytes
    const owner = '0     '; // 6 bytes
    const group = '0     '; // 6 bytes
    const mode = '100644  '; // 8 bytes
    const size = file.content.length.toString().padEnd(10, ' ');
    const fileMagic = '`\n';

    const header = name + timestamp + owner + group + mode + size + fileMagic;
    const headerBytes = encoder.encode(header);
    view.set(headerBytes, offset);
    offset += 60;

    // Write content
    view.set(file.content, offset);
    offset += file.content.length;

    // Add padding if needed
    if (file.content.length % 2 !== 0) {
      view[offset] = 0x0a; // newline padding
      offset++;
    }
  }

  return buffer;
}

// ============================================================================
// Test Helpers - TAR Archive Construction
// ============================================================================

/**
 * Create a TAR archive in memory with the given files
 */
function createTarArchive(files: { name: string; content: Uint8Array }[]): ArrayBuffer {
  const blocks: Uint8Array[] = [];

  for (const file of files) {
    // Create header block (512 bytes)
    const header = new Uint8Array(512);

    // Name (bytes 0-99)
    const nameBytes = new TextEncoder().encode(file.name);
    header.set(nameBytes.slice(0, 100), 0);

    // Mode (bytes 100-107) - octal string
    const modeBytes = new TextEncoder().encode('0000644\0');
    header.set(modeBytes, 100);

    // UID (bytes 108-115) - octal string
    const uidBytes = new TextEncoder().encode('0000000\0');
    header.set(uidBytes, 108);

    // GID (bytes 116-123) - octal string
    const gidBytes = new TextEncoder().encode('0000000\0');
    header.set(gidBytes, 116);

    // Size (bytes 124-135) - octal string
    const sizeStr = file.content.length.toString(8).padStart(11, '0') + '\0';
    const sizeBytes = new TextEncoder().encode(sizeStr);
    header.set(sizeBytes, 124);

    // Mtime (bytes 136-147) - octal string
    const mtimeBytes = new TextEncoder().encode('00000000000\0');
    header.set(mtimeBytes, 136);

    // Type flag (byte 156) - '0' for regular file
    header[156] = 0x30; // '0'

    // Calculate checksum (bytes 148-155)
    // First, fill checksum field with spaces
    for (let i = 148; i < 156; i++) {
      header[i] = 0x20; // space
    }

    // Sum all bytes
    let checksum = 0;
    for (let i = 0; i < 512; i++) {
      checksum += header[i];
    }

    // Write checksum as octal string with trailing space and null
    const checksumStr = checksum.toString(8).padStart(6, '0') + '\0 ';
    const checksumBytes = new TextEncoder().encode(checksumStr);
    header.set(checksumBytes, 148);

    blocks.push(header);

    // Add data blocks (padded to 512-byte boundary)
    const dataBlocks = Math.ceil(file.content.length / 512);
    for (let i = 0; i < dataBlocks; i++) {
      const block = new Uint8Array(512);
      const start = i * 512;
      const end = Math.min(start + 512, file.content.length);
      block.set(file.content.slice(start, end), 0);
      blocks.push(block);
    }
  }

  // Add two zero blocks for end of archive
  blocks.push(new Uint8Array(512));
  blocks.push(new Uint8Array(512));

  // Concatenate all blocks
  const totalSize = blocks.reduce((sum, b) => sum + b.length, 0);
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const block of blocks) {
    result.set(block, offset);
    offset += block.length;
  }

  return result.buffer;
}

// ============================================================================
// Test Helpers - Deb Package Construction
// ============================================================================

/**
 * Create a minimal .deb package in memory with gzip-compressed control archive
 */
async function createDebPackage(controlContent: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();

  // Create control tar archive
  const controlTar = createTarArchive([
    { name: './control', content: encoder.encode(controlContent) },
  ]);

  // Gzip compress the control tar
  const controlTarGz = await gzipCompress(new Uint8Array(controlTar));

  // Create AR archive with deb structure
  const debArchive = createArArchive([
    { name: 'debian-binary', content: encoder.encode('2.0\n') },
    { name: 'control.tar.gz', content: controlTarGz },
    { name: 'data.tar.gz', content: new Uint8Array([0x1f, 0x8b, 0x08, 0x00]) }, // minimal gzip
  ]);

  return debArchive;
}

// ============================================================================
// parseControlFile Tests
// ============================================================================

describe('parseControlFile', () => {
  it('parses a simple control file', () => {
    const content = `Package: hello-world
Version: 1.0.0
Architecture: amd64
Maintainer: Test User <test@example.com>
Installed-Size: 1234
Depends: libc6 (>= 2.17)
Section: utils
Priority: optional
Description: A test package
 This is a longer description
 that spans multiple lines.`;

    const result = parseControlFile(content);

    expect(result.package).toBe('hello-world');
    expect(result.version).toBe('1.0.0');
    expect(result.architecture).toBe('amd64');
    expect(result.maintainer).toBe('Test User <test@example.com>');
    expect(result.installedSize).toBe(1234);
    expect(result.depends).toBe('libc6 (>= 2.17)');
    expect(result.section).toBe('utils');
    expect(result.priority).toBe('optional');
    expect(result.description).toContain('A test package');
  });

  it('handles empty/missing fields', () => {
    const content = `Package: minimal
Version: 0.1
Architecture: all`;

    const result = parseControlFile(content);

    expect(result.package).toBe('minimal');
    expect(result.version).toBe('0.1');
    expect(result.architecture).toBe('all');
    expect(result.depends).toBe('');
    expect(result.maintainer).toBe('');
  });

  it('handles all optional fields', () => {
    const content = `Package: full-pkg
Version: 2.0.0
Architecture: arm64
Maintainer: Dev Team <dev@example.org>
Installed-Size: 5678
Depends: libc6, libssl3
Recommends: extra-tools
Suggests: docs
Conflicts: old-pkg
Replaces: legacy-pkg
Provides: virtual-pkg
Section: net
Priority: important
Homepage: https://example.org/full-pkg
Description: Full package example`;

    const result = parseControlFile(content);

    expect(result.package).toBe('full-pkg');
    expect(result.version).toBe('2.0.0');
    expect(result.architecture).toBe('arm64');
    expect(result.recommends).toBe('extra-tools');
    expect(result.suggests).toBe('docs');
    expect(result.conflicts).toBe('old-pkg');
    expect(result.replaces).toBe('legacy-pkg');
    expect(result.provides).toBe('virtual-pkg');
    expect(result.homepage).toBe('https://example.org/full-pkg');
    expect(result.priority).toBe('important');
  });

  it('handles multi-line descriptions with tabs', () => {
    const content = `Package: multiline
Version: 1.0
Architecture: all
Description: Short summary
\tThis is a tabbed continuation.
\tAnother tabbed line.`;

    const result = parseControlFile(content);

    expect(result.description).toContain('Short summary');
    expect(result.description).toContain('This is a tabbed continuation');
  });

  it('handles colons in field values', () => {
    const content = `Package: colon-test
Version: 1.0
Homepage: https://example.com:8080/path
Description: URL with port: example.com:8080`;

    const result = parseControlFile(content);

    expect(result.homepage).toBe('https://example.com:8080/path');
    expect(result.description).toContain('URL with port');
  });

  it('handles version strings with epochs and revisions', () => {
    const content = `Package: versioned
Version: 2:1.2.3-4ubuntu5
Architecture: amd64`;

    const result = parseControlFile(content);

    expect(result.version).toBe('2:1.2.3-4ubuntu5');
  });

  it('handles complex dependency strings', () => {
    const content = `Package: depends-test
Version: 1.0
Depends: libc6 (>= 2.17), libssl3 (>= 3.0) | libssl1.1, python3 | python2.7`;

    const result = parseControlFile(content);

    expect(result.depends).toBe('libc6 (>= 2.17), libssl3 (>= 3.0) | libssl1.1, python3 | python2.7');
  });

  it('defaults architecture to all when missing', () => {
    const content = `Package: no-arch
Version: 1.0`;

    const result = parseControlFile(content);

    expect(result.architecture).toBe('all');
  });

  it('defaults priority to optional when missing', () => {
    const content = `Package: no-priority
Version: 1.0`;

    const result = parseControlFile(content);

    expect(result.priority).toBe('optional');
  });
});

// ============================================================================
// parseDebBufferAsync Tests
// ============================================================================

describe('parseDebBufferAsync', () => {
  it('parses a minimal deb package', async () => {
    const controlContent = `Package: test-pkg
Version: 1.0.0
Architecture: amd64
Maintainer: Test <test@example.com>
Description: Test package`;

    const debPackage = await createDebPackage(controlContent);
    const result = await parseDebBufferAsync(debPackage);

    expect(result.package).toBe('test-pkg');
    expect(result.version).toBe('1.0.0');
    expect(result.architecture).toBe('amd64');
  });

  it('parses package with all fields', async () => {
    const controlContent = `Package: full-pkg
Version: 2.5.1
Architecture: arm64
Maintainer: Full Team <full@example.com>
Installed-Size: 12345
Depends: libc6, libm
Section: utils
Priority: optional
Homepage: https://full-pkg.example.com
Description: Full package with all fields`;

    const debPackage = await createDebPackage(controlContent);
    const result = await parseDebBufferAsync(debPackage);

    expect(result.package).toBe('full-pkg');
    expect(result.version).toBe('2.5.1');
    expect(result.architecture).toBe('arm64');
    expect(result.installedSize).toBe(12345);
    expect(result.depends).toBe('libc6, libm');
    expect(result.section).toBe('utils');
    expect(result.homepage).toBe('https://full-pkg.example.com');
  });

  it('throws when control archive is missing', async () => {
    const encoder = new TextEncoder();

    // Create AR archive without control.tar.gz
    const badDeb = createArArchive([
      { name: 'debian-binary', content: encoder.encode('2.0\n') },
      { name: 'data.tar.gz', content: new Uint8Array([0x1f, 0x8b, 0x08]) },
    ]);

    await expect(parseDebBufferAsync(badDeb)).rejects.toThrow('No control archive found');
  });

  it('throws when control file is missing in tar', async () => {
    const encoder = new TextEncoder();

    // Create tar without control file
    const emptyTar = createTarArchive([
      { name: './md5sums', content: encoder.encode('checksum data') },
    ]);
    const tarGz = await gzipCompress(new Uint8Array(emptyTar));

    const badDeb = createArArchive([
      { name: 'debian-binary', content: encoder.encode('2.0\n') },
      { name: 'control.tar.gz', content: tarGz },
    ]);

    await expect(parseDebBufferAsync(badDeb)).rejects.toThrow('No control file found');
  });

});

// ============================================================================
// parseDebBufferAsync - Compression Format Tests
// ============================================================================

describe('parseDebBufferAsync compression formats', () => {
  const controlContent = `Package: compression-test
Version: 1.0.0
Architecture: amd64
Description: Testing compression formats`;

  it('routes zstd-compressed control archive to fzstd decompression', async () => {
    const encoder = new TextEncoder();

    // Create AR archive with .zst control containing invalid zstd data
    // This verifies the code correctly identifies .zst and routes to fzstd
    // (rather than throwing "Unknown control archive compression")
    const debArchive = createArArchive([
      { name: 'debian-binary', content: encoder.encode('2.0\n') },
      { name: 'control.tar.zst', content: new Uint8Array([0x00, 0x01, 0x02, 0x03]) },
      { name: 'data.tar.zst', content: new Uint8Array(0) },
    ]);

    // Should throw fzstd error, not "Unknown control archive compression"
    await expect(parseDebBufferAsync(debArchive))
      .rejects.toThrow(/invalid zstd|unexpected eof/i);
  });

  it('parses deb with uncompressed control archive', async () => {
    const encoder = new TextEncoder();

    // Create control tar archive (uncompressed)
    const controlTar = createTarArchive([
      { name: './control', content: encoder.encode(controlContent) },
    ]);

    // Create AR archive with uncompressed control.tar
    const debArchive = createArArchive([
      { name: 'debian-binary', content: encoder.encode('2.0\n') },
      { name: 'control.tar', content: new Uint8Array(controlTar) },
      { name: 'data.tar', content: new Uint8Array(0) },
    ]);

    const result = await parseDebBufferAsync(debArchive);
    expect(result.package).toBe('compression-test');
    expect(result.version).toBe('1.0.0');
  });

  it('throws on unknown compression format', async () => {
    const encoder = new TextEncoder();

    // Create AR archive with unsupported compression
    const badDeb = createArArchive([
      { name: 'debian-binary', content: encoder.encode('2.0\n') },
      { name: 'control.tar.lz4', content: new Uint8Array([0x04, 0x22, 0x4d, 0x18]) },
      { name: 'data.tar.lz4', content: new Uint8Array(0) },
    ]);

    await expect(parseDebBufferAsync(badDeb))
      .rejects.toThrow('Unknown control archive compression: control.tar.lz4');
  });

  it('throws on bz2 compression (not supported)', async () => {
    const encoder = new TextEncoder();

    const badDeb = createArArchive([
      { name: 'debian-binary', content: encoder.encode('2.0\n') },
      { name: 'control.tar.bz2', content: new Uint8Array([0x42, 0x5a, 0x68]) },
    ]);

    await expect(parseDebBufferAsync(badDeb))
      .rejects.toThrow('Unknown control archive compression: control.tar.bz2');
  });
});

// ============================================================================
// AR Archive Parser Tests
// ============================================================================

describe('parseArHeaders', () => {
  it('parses a valid AR archive header', () => {
    // Create a minimal AR archive in memory
    const encoder = new TextEncoder();
    const magic = encoder.encode('!<arch>\n');

    // File header: name(16) + timestamp(12) + owner(6) + group(6) + mode(8) + size(10) + magic(2)
    const header =
      'test.txt/       ' + // name (16 bytes, padded)
      '1234567890  ' + // timestamp (12 bytes)
      '1000  ' + // owner (6 bytes)
      '1000  ' + // group (6 bytes)
      '100644  ' + // mode (8 bytes)
      '5         ' + // size (10 bytes)
      '`\n'; // file magic (2 bytes)

    const headerBytes = encoder.encode(header);
    const data = encoder.encode('hello');

    // Combine into buffer
    const buffer = new ArrayBuffer(magic.length + headerBytes.length + data.length);
    const view = new Uint8Array(buffer);
    view.set(magic, 0);
    view.set(headerBytes, magic.length);
    view.set(data, magic.length + headerBytes.length);

    const entries = parseArHeaders(buffer);

    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('test.txt');
    expect(entries[0].size).toBe(5);
  });

  it('throws on invalid magic', () => {
    const encoder = new TextEncoder();
    const buffer = encoder.encode('not an ar archive');

    expect(() => parseArHeaders(buffer.buffer)).toThrow('Invalid AR archive');
  });

  it('parses multiple files', () => {
    const encoder = new TextEncoder();
    const archive = createArArchive([
      { name: 'file1.txt', content: encoder.encode('Hello') },
      { name: 'file2.txt', content: encoder.encode('World!') },
      { name: 'file3.txt', content: encoder.encode('Test') },
    ]);

    const entries = parseArHeaders(archive);

    expect(entries).toHaveLength(3);
    expect(entries[0].name).toBe('file1.txt');
    expect(entries[0].size).toBe(5);
    expect(entries[1].name).toBe('file2.txt');
    expect(entries[1].size).toBe(6);
    expect(entries[2].name).toBe('file3.txt');
    expect(entries[2].size).toBe(4);
  });

  it('handles odd-sized files with padding', () => {
    const encoder = new TextEncoder();
    // Create files with odd sizes to test padding
    const archive = createArArchive([
      { name: 'odd.txt', content: encoder.encode('abc') }, // 3 bytes, needs padding
      { name: 'even.txt', content: encoder.encode('abcd') }, // 4 bytes, no padding
    ]);

    const entries = parseArHeaders(archive);

    expect(entries).toHaveLength(2);
    expect(entries[0].size).toBe(3);
    expect(entries[1].size).toBe(4);
  });

  it('parses deb-like structure', () => {
    const encoder = new TextEncoder();
    const archive = createArArchive([
      { name: 'debian-binary', content: encoder.encode('2.0\n') },
      { name: 'control.tar.gz', content: new Uint8Array([0x1f, 0x8b, 0x08]) }, // gzip magic
      { name: 'data.tar.gz', content: new Uint8Array([0x1f, 0x8b, 0x08]) },
    ]);

    const entries = parseArHeaders(archive);

    expect(entries).toHaveLength(3);
    expect(entries[0].name).toBe('debian-binary');
    expect(entries[1].name).toBe('control.tar.gz');
    expect(entries[2].name).toBe('data.tar.gz');
  });
});

describe('extractArFile', () => {
  it('extracts file content correctly', () => {
    const encoder = new TextEncoder();
    const content = encoder.encode('Hello, World!');
    const archive = createArArchive([
      { name: 'test.txt', content },
    ]);

    const entries = parseArHeaders(archive);
    const extracted = extractArFile(archive, entries[0]);

    expect(new TextDecoder().decode(extracted)).toBe('Hello, World!');
  });

  it('extracts correct file from multiple', () => {
    const encoder = new TextEncoder();
    const archive = createArArchive([
      { name: 'first.txt', content: encoder.encode('First') },
      { name: 'second.txt', content: encoder.encode('Second') },
      { name: 'third.txt', content: encoder.encode('Third') },
    ]);

    const entries = parseArHeaders(archive);
    const second = extractArFile(archive, entries[1]);

    expect(new TextDecoder().decode(second)).toBe('Second');
  });

  it('throws when file extends beyond buffer', () => {
    const encoder = new TextEncoder();
    const archive = createArArchive([
      { name: 'test.txt', content: encoder.encode('Hello') },
    ]);

    const entries = parseArHeaders(archive);
    // Corrupt the entry to claim more size than available
    entries[0].size = 10000;

    expect(() => extractArFile(archive, entries[0])).toThrow('Cannot extract');
  });
});

describe('findArEntry', () => {
  it('finds entry by exact string name', () => {
    const encoder = new TextEncoder();
    const archive = createArArchive([
      { name: 'debian-binary', content: encoder.encode('2.0\n') },
      { name: 'control.tar.gz', content: encoder.encode('control') },
      { name: 'data.tar.gz', content: encoder.encode('data') },
    ]);

    const entries = parseArHeaders(archive);
    const found = findArEntry(entries, 'control.tar.gz');

    expect(found).toBeDefined();
    expect(found!.name).toBe('control.tar.gz');
  });

  it('finds entry by regex pattern', () => {
    const encoder = new TextEncoder();
    const archive = createArArchive([
      { name: 'debian-binary', content: encoder.encode('2.0\n') },
      { name: 'control.tar.xz', content: encoder.encode('control') },
      { name: 'data.tar.xz', content: encoder.encode('data') },
    ]);

    const entries = parseArHeaders(archive);
    const found = findArEntry(entries, /^control\.tar\./);

    expect(found).toBeDefined();
    expect(found!.name).toBe('control.tar.xz');
  });

  it('returns undefined when not found', () => {
    const encoder = new TextEncoder();
    const archive = createArArchive([
      { name: 'file.txt', content: encoder.encode('content') },
    ]);

    const entries = parseArHeaders(archive);
    const found = findArEntry(entries, 'nonexistent.txt');

    expect(found).toBeUndefined();
  });
});

// ============================================================================
// TAR Archive Parser Tests
// ============================================================================

describe('parseTar', () => {
  it('parses an empty tar gracefully', () => {
    // Two zero blocks indicate end of archive
    const buffer = new ArrayBuffer(1024);
    const entries = parseTar(buffer);
    expect(entries).toHaveLength(0);
  });

  it('parses a single file', () => {
    const encoder = new TextEncoder();
    const archive = createTarArchive([
      { name: 'hello.txt', content: encoder.encode('Hello, World!') },
    ]);

    const entries = parseTar(archive);

    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('hello.txt');
    expect(entries[0].size).toBe(13);
    expect(new TextDecoder().decode(entries[0].data)).toBe('Hello, World!');
  });

  it('parses multiple files', () => {
    const encoder = new TextEncoder();
    const archive = createTarArchive([
      { name: 'file1.txt', content: encoder.encode('First') },
      { name: 'file2.txt', content: encoder.encode('Second') },
      { name: 'file3.txt', content: encoder.encode('Third') },
    ]);

    const entries = parseTar(archive);

    expect(entries).toHaveLength(3);
    expect(entries[0].name).toBe('file1.txt');
    expect(entries[1].name).toBe('file2.txt');
    expect(entries[2].name).toBe('file3.txt');
  });

  it('handles files larger than 512 bytes', () => {
    const content = new Uint8Array(1000);
    for (let i = 0; i < 1000; i++) {
      content[i] = i % 256;
    }

    const archive = createTarArchive([
      { name: 'large.bin', content },
    ]);

    const entries = parseTar(archive);

    expect(entries).toHaveLength(1);
    expect(entries[0].size).toBe(1000);
    expect(entries[0].data.length).toBe(1000);
    // Verify content integrity
    for (let i = 0; i < 1000; i++) {
      expect(entries[0].data[i]).toBe(i % 256);
    }
  });

  it('strips leading ./ from filenames', () => {
    const encoder = new TextEncoder();
    const archive = createTarArchive([
      { name: './control', content: encoder.encode('Package: test') },
    ]);

    const entries = parseTar(archive);

    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('control');
  });

  it('parses control-like tar structure', () => {
    const encoder = new TextEncoder();
    const controlContent = `Package: test-pkg
Version: 1.0.0
Architecture: amd64`;
    const archive = createTarArchive([
      { name: './control', content: encoder.encode(controlContent) },
      { name: './md5sums', content: encoder.encode('abc123 /usr/bin/test') },
    ]);

    const entries = parseTar(archive);

    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe('control');
    expect(new TextDecoder().decode(entries[0].data)).toContain('Package: test-pkg');
  });
});

describe('findTarEntry', () => {
  it('finds entry by exact string name', () => {
    const encoder = new TextEncoder();
    const archive = createTarArchive([
      { name: 'file1.txt', content: encoder.encode('First') },
      { name: 'control', content: encoder.encode('Control content') },
      { name: 'file2.txt', content: encoder.encode('Second') },
    ]);

    const entries = parseTar(archive);
    const found = findTarEntry(entries, 'control');

    expect(found).toBeDefined();
    expect(found!.name).toBe('control');
  });

  it('finds entry by suffix match', () => {
    const encoder = new TextEncoder();
    const archive = createTarArchive([
      { name: 'some/path/control', content: encoder.encode('Control') },
    ]);

    const entries = parseTar(archive);
    const found = findTarEntry(entries, 'control');

    expect(found).toBeDefined();
    expect(found!.name).toBe('some/path/control');
  });

  it('finds entry by regex pattern', () => {
    const encoder = new TextEncoder();
    const archive = createTarArchive([
      { name: 'file.txt', content: encoder.encode('Text') },
      { name: 'file.json', content: encoder.encode('{}') },
      { name: 'file.xml', content: encoder.encode('<xml/>') },
    ]);

    const entries = parseTar(archive);
    const found = findTarEntry(entries, /\.json$/);

    expect(found).toBeDefined();
    expect(found!.name).toBe('file.json');
  });

  it('returns undefined when not found', () => {
    const encoder = new TextEncoder();
    const archive = createTarArchive([
      { name: 'file.txt', content: encoder.encode('content') },
    ]);

    const entries = parseTar(archive);
    const found = findTarEntry(entries, 'nonexistent');

    expect(found).toBeUndefined();
  });
});

// ============================================================================
// AR Parser Edge Cases
// ============================================================================

describe('parseArHeaders edge cases', () => {
  it('parses BSD-style extended filenames (#1/ prefix)', () => {
    const encoder = new TextEncoder();
    const magic = encoder.encode('!<arch>\n');

    // BSD extended filename: #1/<length> indicates the filename is embedded
    // in the first <length> bytes of the data section
    const longName = 'very_long_filename_that_exceeds_16_chars.txt';
    const nameLength = longName.length;
    const content = encoder.encode('Hello');

    // Header with #1/<length> format
    const headerName = `#1/${nameLength}`.padEnd(16, ' ');
    const timestamp = '0           ';
    const owner = '0     ';
    const group = '0     ';
    const mode = '100644  ';
    // Size includes the filename length + actual content
    const totalSize = nameLength + content.length;
    const size = totalSize.toString().padEnd(10, ' ');
    const fileMagic = '`\n';

    const header = headerName + timestamp + owner + group + mode + size + fileMagic;
    const headerBytes = encoder.encode(header);
    const nameBytes = encoder.encode(longName);

    // Total: magic + header + extended name + content
    const buffer = new ArrayBuffer(magic.length + headerBytes.length + nameLength + content.length);
    const view = new Uint8Array(buffer);
    let offset = 0;

    view.set(magic, offset);
    offset += magic.length;
    view.set(headerBytes, offset);
    offset += headerBytes.length;
    view.set(nameBytes, offset);
    offset += nameLength;
    view.set(content, offset);

    const entries = parseArHeaders(buffer);

    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe(longName);
    // Verify offset and size are adjusted to skip the embedded filename
    expect(entries[0].size).toBe(content.length);
    expect(entries[0].offset).toBe(magic.length + headerBytes.length + nameLength);

    // Verify extraction returns only the content, not the embedded filename
    const extracted = extractArFile(buffer, entries[0]);
    expect(extracted).toEqual(content);
  });

  it('throws on invalid file header magic', () => {
    const encoder = new TextEncoder();
    const magic = encoder.encode('!<arch>\n');

    // Create header with invalid file magic (should be `\n)
    const name = 'test.txt/       ';
    const timestamp = '0           ';
    const owner = '0     ';
    const group = '0     ';
    const mode = '100644  ';
    const size = '5         ';
    const badFileMagic = 'XX'; // Invalid - should be `\n

    const header = name + timestamp + owner + group + mode + size + badFileMagic;
    const headerBytes = encoder.encode(header);
    const content = encoder.encode('hello');

    const buffer = new ArrayBuffer(magic.length + headerBytes.length + content.length);
    const view = new Uint8Array(buffer);
    view.set(magic, 0);
    view.set(headerBytes, magic.length);
    view.set(content, magic.length + headerBytes.length);

    expect(() => parseArHeaders(buffer)).toThrow(/Invalid AR file header.*bad magic/);
  });
});

// ============================================================================
// TAR Parser Edge Cases
// ============================================================================

describe('parseTar edge cases', () => {
  it('handles UStar format with prefix for long paths', () => {
    const encoder = new TextEncoder();
    const content = encoder.encode('File content');

    // Create a TAR header with UStar format (prefix field at offset 345)
    const header = new Uint8Array(512);

    // Short name (bytes 0-99) - just the filename part
    const nameBytes = encoder.encode('deeply_nested_file.txt');
    header.set(nameBytes.slice(0, 100), 0);

    // Mode (bytes 100-107)
    header.set(encoder.encode('0000644\0'), 100);

    // UID/GID (bytes 108-123)
    header.set(encoder.encode('0000000\0'), 108);
    header.set(encoder.encode('0000000\0'), 116);

    // Size (bytes 124-135)
    const sizeStr = content.length.toString(8).padStart(11, '0') + '\0';
    header.set(encoder.encode(sizeStr), 124);

    // Mtime (bytes 136-147)
    header.set(encoder.encode('00000000000\0'), 136);

    // Type flag (byte 156) - '0' for regular file
    header[156] = 0x30;

    // UStar magic (bytes 257-262) - "ustar\0"
    header.set(encoder.encode('ustar\0'), 257);

    // UStar version (bytes 263-264) - "00"
    header.set(encoder.encode('00'), 263);

    // Prefix (bytes 345-499) - the directory path prefix
    const prefix = 'very/long/directory/path/that/exceeds/100/chars';
    header.set(encoder.encode(prefix), 345);

    // Calculate checksum
    for (let i = 148; i < 156; i++) header[i] = 0x20;
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += header[i];
    const checksumStr = checksum.toString(8).padStart(6, '0') + '\0 ';
    header.set(encoder.encode(checksumStr), 148);

    // Build archive
    const dataBlock = new Uint8Array(512);
    dataBlock.set(content, 0);
    const endBlocks = new Uint8Array(1024);

    const archive = new Uint8Array(512 + 512 + 1024);
    archive.set(header, 0);
    archive.set(dataBlock, 512);
    archive.set(endBlocks, 1024);

    const entries = parseTar(archive.buffer);

    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe(prefix + '/deeply_nested_file.txt');
  });

  it('skips directory entries (type flag 5)', () => {
    const encoder = new TextEncoder();
    const content = encoder.encode('File in dir');

    // Create a directory entry (type 5)
    const dirHeader = new Uint8Array(512);
    dirHeader.set(encoder.encode('mydir/'), 0);
    dirHeader.set(encoder.encode('0000755\0'), 100);
    dirHeader.set(encoder.encode('0000000\0'), 108);
    dirHeader.set(encoder.encode('0000000\0'), 116);
    dirHeader.set(encoder.encode('00000000000\0'), 124); // size 0
    dirHeader.set(encoder.encode('00000000000\0'), 136);
    dirHeader[156] = 0x35; // '5' = directory

    for (let i = 148; i < 156; i++) dirHeader[i] = 0x20;
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += dirHeader[i];
    dirHeader.set(encoder.encode(checksum.toString(8).padStart(6, '0') + '\0 '), 148);

    // Create a file entry
    const fileHeader = new Uint8Array(512);
    fileHeader.set(encoder.encode('mydir/file.txt'), 0);
    fileHeader.set(encoder.encode('0000644\0'), 100);
    fileHeader.set(encoder.encode('0000000\0'), 108);
    fileHeader.set(encoder.encode('0000000\0'), 116);
    const sizeStr = content.length.toString(8).padStart(11, '0') + '\0';
    fileHeader.set(encoder.encode(sizeStr), 124);
    fileHeader.set(encoder.encode('00000000000\0'), 136);
    fileHeader[156] = 0x30; // '0' = regular file

    for (let i = 148; i < 156; i++) fileHeader[i] = 0x20;
    checksum = 0;
    for (let i = 0; i < 512; i++) checksum += fileHeader[i];
    fileHeader.set(encoder.encode(checksum.toString(8).padStart(6, '0') + '\0 '), 148);

    const dataBlock = new Uint8Array(512);
    dataBlock.set(content, 0);
    const endBlocks = new Uint8Array(1024);

    const archive = new Uint8Array(512 + 512 + 512 + 1024);
    archive.set(dirHeader, 0);
    archive.set(fileHeader, 512);
    archive.set(dataBlock, 1024);
    archive.set(endBlocks, 1536);

    const entries = parseTar(archive.buffer);

    // Should only have the file, not the directory
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('mydir/file.txt');
  });

  it('skips GNU long name entries (type flag L)', () => {
    const encoder = new TextEncoder();
    const fileContent = encoder.encode('Actual file content');

    // Create a GNU long name entry (type L)
    // This entry's data contains the actual filename for the next entry
    const longName = 'a'.repeat(200) + '.txt'; // Longer than 100 chars
    const longNameEntry = new Uint8Array(512);
    longNameEntry.set(encoder.encode('././@LongLink'), 0);
    longNameEntry.set(encoder.encode('0000644\0'), 100);
    longNameEntry.set(encoder.encode('0000000\0'), 108);
    longNameEntry.set(encoder.encode('0000000\0'), 116);
    const longNameSizeStr = (longName.length + 1).toString(8).padStart(11, '0') + '\0';
    longNameEntry.set(encoder.encode(longNameSizeStr), 124);
    longNameEntry.set(encoder.encode('00000000000\0'), 136);
    longNameEntry[156] = 0x4c; // 'L' = long name

    for (let i = 148; i < 156; i++) longNameEntry[i] = 0x20;
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += longNameEntry[i];
    longNameEntry.set(encoder.encode(checksum.toString(8).padStart(6, '0') + '\0 '), 148);

    // Long name data block
    const longNameData = new Uint8Array(512);
    longNameData.set(encoder.encode(longName + '\0'), 0);

    // The actual file entry (with truncated name)
    const fileHeader = new Uint8Array(512);
    fileHeader.set(encoder.encode('truncated_name.txt'), 0);
    fileHeader.set(encoder.encode('0000644\0'), 100);
    fileHeader.set(encoder.encode('0000000\0'), 108);
    fileHeader.set(encoder.encode('0000000\0'), 116);
    const fileSizeStr = fileContent.length.toString(8).padStart(11, '0') + '\0';
    fileHeader.set(encoder.encode(fileSizeStr), 124);
    fileHeader.set(encoder.encode('00000000000\0'), 136);
    fileHeader[156] = 0x30; // '0' = regular file

    for (let i = 148; i < 156; i++) fileHeader[i] = 0x20;
    checksum = 0;
    for (let i = 0; i < 512; i++) checksum += fileHeader[i];
    fileHeader.set(encoder.encode(checksum.toString(8).padStart(6, '0') + '\0 '), 148);

    const fileData = new Uint8Array(512);
    fileData.set(fileContent, 0);
    const endBlocks = new Uint8Array(1024);

    const archive = new Uint8Array(512 + 512 + 512 + 512 + 1024);
    archive.set(longNameEntry, 0);
    archive.set(longNameData, 512);
    archive.set(fileHeader, 1024);
    archive.set(fileData, 1536);
    archive.set(endBlocks, 2048);

    const entries = parseTar(archive.buffer);

    // Should have the file but not the long name metadata entry
    // Current implementation skips 'L' type entries
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('truncated_name.txt');
  });

  it('skips POSIX extended headers (type flags x and g)', () => {
    const encoder = new TextEncoder();
    const fileContent = encoder.encode('File content');

    // Create a local extended header (type x)
    const extHeader = new Uint8Array(512);
    extHeader.set(encoder.encode('PaxHeaders/file.txt'), 0);
    extHeader.set(encoder.encode('0000644\0'), 100);
    extHeader.set(encoder.encode('0000000\0'), 108);
    extHeader.set(encoder.encode('0000000\0'), 116);
    // Extended header data (e.g., "19 path=long/path\n")
    const extData = '19 path=somepath\n';
    const extSizeStr = extData.length.toString(8).padStart(11, '0') + '\0';
    extHeader.set(encoder.encode(extSizeStr), 124);
    extHeader.set(encoder.encode('00000000000\0'), 136);
    extHeader[156] = 0x78; // 'x' = local extended header

    for (let i = 148; i < 156; i++) extHeader[i] = 0x20;
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += extHeader[i];
    extHeader.set(encoder.encode(checksum.toString(8).padStart(6, '0') + '\0 '), 148);

    const extDataBlock = new Uint8Array(512);
    extDataBlock.set(encoder.encode(extData), 0);

    // The actual file entry
    const fileHeader = new Uint8Array(512);
    fileHeader.set(encoder.encode('actual_file.txt'), 0);
    fileHeader.set(encoder.encode('0000644\0'), 100);
    fileHeader.set(encoder.encode('0000000\0'), 108);
    fileHeader.set(encoder.encode('0000000\0'), 116);
    const fileSizeStr = fileContent.length.toString(8).padStart(11, '0') + '\0';
    fileHeader.set(encoder.encode(fileSizeStr), 124);
    fileHeader.set(encoder.encode('00000000000\0'), 136);
    fileHeader[156] = 0x30; // '0' = regular file

    for (let i = 148; i < 156; i++) fileHeader[i] = 0x20;
    checksum = 0;
    for (let i = 0; i < 512; i++) checksum += fileHeader[i];
    fileHeader.set(encoder.encode(checksum.toString(8).padStart(6, '0') + '\0 '), 148);

    const fileData = new Uint8Array(512);
    fileData.set(fileContent, 0);
    const endBlocks = new Uint8Array(1024);

    const archive = new Uint8Array(512 + 512 + 512 + 512 + 1024);
    archive.set(extHeader, 0);
    archive.set(extDataBlock, 512);
    archive.set(fileHeader, 1024);
    archive.set(fileData, 1536);
    archive.set(endBlocks, 2048);

    const entries = parseTar(archive.buffer);

    // Should only have the regular file, not the extended header
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('actual_file.txt');
    expect(new TextDecoder().decode(entries[0].data)).toBe('File content');
  });
});
