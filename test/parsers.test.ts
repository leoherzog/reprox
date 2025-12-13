import { describe, it, expect } from 'vitest';
import { parseControlFile } from '../src/parsers/deb';
import { parseArHeaders } from '../src/parsers/ar';
import { parseTar } from '../src/parsers/tar';

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
});

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
});

describe('parseTar', () => {
  it('parses an empty tar gracefully', () => {
    // Two zero blocks indicate end of archive
    const buffer = new ArrayBuffer(1024);
    const entries = parseTar(buffer);
    expect(entries).toHaveLength(0);
  });
});
