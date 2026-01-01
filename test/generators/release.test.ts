import { describe, it, expect } from 'vitest';
import {
  generateReleaseFile,
  buildReleaseEntriesForArch,
  buildReleaseEntries,
  defaultReleaseConfig,
  type ReleaseConfig,
  type ReleaseFileEntry,
} from '../../src/generators/release';

// ============================================================================
// Test Helpers
// ============================================================================

function createReleaseConfig(overrides: Partial<ReleaseConfig> = {}): ReleaseConfig {
  return {
    origin: 'test/repo',
    label: 'repo',
    suite: 'stable',
    codename: 'stable',
    architectures: ['amd64', 'arm64', 'all'],
    components: ['main'],
    description: 'Test repository',
    date: new Date('2024-01-15T12:30:45Z'),
    ...overrides,
  };
}

function createFileEntry(overrides: Partial<ReleaseFileEntry> = {}): ReleaseFileEntry {
  return {
    path: 'main/binary-amd64/Packages',
    size: 1234,
    sha256: 'abc123def456',
    ...overrides,
  };
}

// ============================================================================
// generateReleaseFile Tests
// ============================================================================

describe('generateReleaseFile', () => {
  describe('header fields', () => {
    it('includes all required header fields', () => {
      const config = createReleaseConfig();
      const output = generateReleaseFile(config, []);

      expect(output).toContain('Origin: test/repo');
      expect(output).toContain('Label: repo');
      expect(output).toContain('Suite: stable');
      expect(output).toContain('Codename: stable');
      expect(output).toContain('Description: Test repository');
      expect(output).toContain('Acquire-By-Hash: yes');
    });

    it('formats architectures as space-separated list', () => {
      const config = createReleaseConfig({
        architectures: ['amd64', 'arm64', 'i386', 'all'],
      });
      const output = generateReleaseFile(config, []);

      expect(output).toContain('Architectures: amd64 arm64 i386 all');
    });

    it('formats components as space-separated list', () => {
      const config = createReleaseConfig({
        components: ['main', 'contrib', 'non-free'],
      });
      const output = generateReleaseFile(config, []);

      expect(output).toContain('Components: main contrib non-free');
    });

    it('formats date correctly (RFC 7231)', () => {
      const config = createReleaseConfig({
        date: new Date('2024-01-15T12:30:45Z'),
      });
      const output = generateReleaseFile(config, []);

      expect(output).toContain('Date: Mon, 15 Jan 2024 12:30:45 GMT');
    });

    it('uses current date when not specified', () => {
      const config = createReleaseConfig();
      delete (config as Partial<ReleaseConfig>).date;

      const output = generateReleaseFile(config, []);

      // Should contain a Date field with GMT (RFC 7231 format)
      expect(output).toMatch(/Date: \w+, \d{2} \w+ \d{4} \d{2}:\d{2}:\d{2} GMT/);
    });
  });

  describe('checksum sections', () => {
    it('always includes SHA256 section', () => {
      const config = createReleaseConfig();
      const files = [createFileEntry({ sha256: 'sha256hash', path: 'main/binary-amd64/Packages' })];
      const output = generateReleaseFile(config, files);

      expect(output).toContain('SHA256:');
      expect(output).toContain(' sha256hash');
    });

    it('only includes SHA256 (no deprecated MD5 or SHA1)', () => {
      const config = createReleaseConfig();
      const files = [createFileEntry({ sha256: 'sha256hash' })];
      const output = generateReleaseFile(config, files);

      expect(output).not.toContain('MD5Sum:');
      expect(output).not.toContain('SHA1:');
    });

    it('formats checksum entries with padded size', () => {
      const config = createReleaseConfig();
      const files = [
        createFileEntry({ path: 'main/binary-amd64/Packages', size: 123, sha256: 'abc' }),
        createFileEntry({ path: 'main/binary-amd64/Packages.gz', size: 12345678, sha256: 'def' }),
      ];
      const output = generateReleaseFile(config, files);

      // Size should be right-padded to 8 characters
      expect(output).toContain(' abc      123 main/binary-amd64/Packages');
      expect(output).toContain(' def 12345678 main/binary-amd64/Packages.gz');
    });
  });

  describe('multiple files', () => {
    it('includes all file entries', () => {
      const config = createReleaseConfig();
      const files = [
        createFileEntry({ path: 'main/binary-amd64/Packages', sha256: 'hash1' }),
        createFileEntry({ path: 'main/binary-amd64/Packages.gz', sha256: 'hash2' }),
        createFileEntry({ path: 'main/binary-arm64/Packages', sha256: 'hash3' }),
      ];
      const output = generateReleaseFile(config, files);

      expect(output).toContain('main/binary-amd64/Packages');
      expect(output).toContain('main/binary-amd64/Packages.gz');
      expect(output).toContain('main/binary-arm64/Packages');
    });
  });

  describe('output format', () => {
    it('ends with newline', () => {
      const config = createReleaseConfig();
      const output = generateReleaseFile(config, []);

      expect(output.endsWith('\n')).toBe(true);
    });

    it('has no blank lines between sections', () => {
      const config = createReleaseConfig();
      const output = generateReleaseFile(config, [createFileEntry()]);

      expect(output).not.toContain('\n\n');
    });
  });
});

// ============================================================================
// buildReleaseEntriesForArch Tests
// ============================================================================

describe('buildReleaseEntriesForArch', () => {
  it('creates entries for Packages and Packages.gz', async () => {
    const packagesContent = 'Package: test\nVersion: 1.0\n';
    const entries = await buildReleaseEntriesForArch(packagesContent, 'main', 'amd64');

    expect(entries).toHaveLength(2);
    expect(entries[0].path).toBe('main/binary-amd64/Packages');
    expect(entries[1].path).toBe('main/binary-amd64/Packages.gz');
  });

  it('calculates correct size for uncompressed Packages', async () => {
    const packagesContent = 'Package: test\nVersion: 1.0\n';
    const expectedSize = new TextEncoder().encode(packagesContent).length;

    const entries = await buildReleaseEntriesForArch(packagesContent, 'main', 'amd64');

    expect(entries[0].size).toBe(expectedSize);
  });

  it('compressed file is smaller for large content', async () => {
    // Create repetitive content that compresses well
    const packagesContent = 'Package: test\n'.repeat(100);

    const entries = await buildReleaseEntriesForArch(packagesContent, 'main', 'amd64');

    expect(entries[1].size).toBeLessThan(entries[0].size);
  });

  it('generates valid SHA256 hashes', async () => {
    const packagesContent = 'Package: test\nVersion: 1.0\n';

    const entries = await buildReleaseEntriesForArch(packagesContent, 'main', 'amd64');

    // SHA256 hashes should be 64 hex characters
    expect(entries[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entries[1].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles different components', async () => {
    const entries = await buildReleaseEntriesForArch('content', 'contrib', 'amd64');

    expect(entries[0].path).toBe('contrib/binary-amd64/Packages');
    expect(entries[1].path).toBe('contrib/binary-amd64/Packages.gz');
  });

  it('handles different architectures', async () => {
    const entries = await buildReleaseEntriesForArch('content', 'main', 'arm64');

    expect(entries[0].path).toBe('main/binary-arm64/Packages');
    expect(entries[1].path).toBe('main/binary-arm64/Packages.gz');
  });
});

// ============================================================================
// buildReleaseEntries Tests
// ============================================================================

describe('buildReleaseEntries', () => {
  it('builds entries for all architectures', async () => {
    const packagesMap = new Map([
      ['amd64', 'Package: pkg\nArchitecture: amd64\n'],
      ['arm64', 'Package: pkg\nArchitecture: arm64\n'],
    ]);

    const entries = await buildReleaseEntries(packagesMap, 'main');

    expect(entries).toHaveLength(4); // 2 archs * 2 files each
    expect(entries.map(e => e.path)).toContain('main/binary-amd64/Packages');
    expect(entries.map(e => e.path)).toContain('main/binary-amd64/Packages.gz');
    expect(entries.map(e => e.path)).toContain('main/binary-arm64/Packages');
    expect(entries.map(e => e.path)).toContain('main/binary-arm64/Packages.gz');
  });

  it('handles empty map', async () => {
    const entries = await buildReleaseEntries(new Map(), 'main');

    expect(entries).toHaveLength(0);
  });

  it('handles single architecture', async () => {
    const packagesMap = new Map([
      ['all', 'Package: common\nArchitecture: all\n'],
    ]);

    const entries = await buildReleaseEntries(packagesMap, 'main');

    expect(entries).toHaveLength(2);
    expect(entries[0].path).toBe('main/binary-all/Packages');
  });
});

// ============================================================================
// defaultReleaseConfig Tests
// ============================================================================

describe('defaultReleaseConfig', () => {
  it('uses owner/repo as origin', () => {
    const config = defaultReleaseConfig('joshuar', 'go-hass-agent');

    expect(config.origin).toBe('joshuar/go-hass-agent');
  });

  it('uses repo as label', () => {
    const config = defaultReleaseConfig('owner', 'my-repo');

    expect(config.label).toBe('my-repo');
  });

  it('uses stable for suite and codename', () => {
    const config = defaultReleaseConfig('owner', 'repo');

    expect(config.suite).toBe('stable');
    expect(config.codename).toBe('stable');
  });

  it('includes common architectures', () => {
    const config = defaultReleaseConfig('owner', 'repo');

    expect(config.architectures).toContain('amd64');
    expect(config.architectures).toContain('arm64');
    expect(config.architectures).toContain('i386');
    expect(config.architectures).toContain('all');
  });

  it('uses main as component', () => {
    const config = defaultReleaseConfig('owner', 'repo');

    expect(config.components).toEqual(['main']);
  });

  it('includes descriptive description', () => {
    const config = defaultReleaseConfig('owner', 'repo');

    expect(config.description).toContain('owner/repo');
    expect(config.description).toContain('Reprox');
  });
});
