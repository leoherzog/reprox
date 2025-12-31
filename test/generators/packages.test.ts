import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generatePackageEntry,
  generatePackagesFile,
  filterDebAssets,
  filterByArchitecture,
  fetchDebMetadata,
} from '../../src/generators/packages';
import type { PackageEntry, DebianControlData, AssetLike } from '../../src/types';

// ============================================================================
// Test Helpers
// ============================================================================

function createControlData(overrides: Partial<DebianControlData> = {}): DebianControlData {
  return {
    package: 'test-pkg',
    version: '1.0.0',
    architecture: 'amd64',
    maintainer: 'Test <test@example.com>',
    installedSize: 1234,
    depends: '',
    recommends: '',
    suggests: '',
    conflicts: '',
    replaces: '',
    provides: '',
    section: 'utils',
    priority: 'optional',
    homepage: '',
    description: 'Test package description',
    ...overrides,
  };
}

function createPackageEntry(overrides: Partial<PackageEntry> = {}): PackageEntry {
  return {
    controlData: createControlData(overrides.controlData),
    filename: 'pool/main/t/test-pkg/test-pkg_1.0.0_amd64.deb',
    size: 50000,
    sha256: '',
    md5sum: '',
    ...overrides,
  };
}

// ============================================================================
// generatePackageEntry Tests
// ============================================================================

describe('generatePackageEntry', () => {
  it('generates required fields', () => {
    const entry = createPackageEntry();
    const output = generatePackageEntry(entry);

    expect(output).toContain('Package: test-pkg');
    expect(output).toContain('Version: 1.0.0');
    expect(output).toContain('Architecture: amd64');
  });

  it('generates file information', () => {
    const entry = createPackageEntry({
      filename: 'pool/main/t/test/test_1.0_amd64.deb',
      size: 12345,
    });
    const output = generatePackageEntry(entry);

    expect(output).toContain('Filename: pool/main/t/test/test_1.0_amd64.deb');
    expect(output).toContain('Size: 12345');
  });

  it('includes checksums when provided', () => {
    const entry = createPackageEntry({
      sha256: 'abc123def456',
      md5sum: '789xyz',
    });
    const output = generatePackageEntry(entry);

    expect(output).toContain('SHA256: abc123def456');
    expect(output).toContain('MD5sum: 789xyz');
  });

  it('omits checksums when empty', () => {
    const entry = createPackageEntry({
      sha256: '',
      md5sum: '',
    });
    const output = generatePackageEntry(entry);

    expect(output).not.toContain('SHA256:');
    expect(output).not.toContain('MD5sum:');
  });

  it('includes optional control fields when present', () => {
    const entry = createPackageEntry({
      controlData: {
        package: 'full-pkg',
        version: '2.0.0',
        architecture: 'arm64',
        maintainer: 'Full Team <full@example.com>',
        installedSize: 5678,
        depends: 'libc6, libssl3',
        recommends: 'extra-tools',
        suggests: 'docs',
        conflicts: 'old-pkg',
        replaces: 'legacy-pkg',
        provides: 'virtual-pkg',
        section: 'net',
        priority: 'important',
        homepage: 'https://example.com',
        description: 'Full package',
      },
    });
    const output = generatePackageEntry(entry);

    expect(output).toContain('Maintainer: Full Team <full@example.com>');
    expect(output).toContain('Installed-Size: 5678');
    expect(output).toContain('Depends: libc6, libssl3');
    expect(output).toContain('Recommends: extra-tools');
    expect(output).toContain('Suggests: docs');
    expect(output).toContain('Conflicts: old-pkg');
    expect(output).toContain('Replaces: legacy-pkg');
    expect(output).toContain('Provides: virtual-pkg');
    expect(output).toContain('Section: net');
    expect(output).toContain('Priority: important');
    expect(output).toContain('Homepage: https://example.com');
  });

  it('omits optional fields when empty', () => {
    const entry = createPackageEntry({
      controlData: {
        package: 'minimal',
        version: '1.0',
        architecture: 'all',
        maintainer: '',
        installedSize: 0,
        depends: '',
        recommends: '',
        suggests: '',
        conflicts: '',
        replaces: '',
        provides: '',
        section: '',
        priority: '',
        homepage: '',
        description: '',
      },
    });
    const output = generatePackageEntry(entry);

    expect(output).not.toContain('Maintainer:');
    expect(output).not.toContain('Installed-Size:');
    expect(output).not.toContain('Depends:');
    expect(output).not.toContain('Recommends:');
    expect(output).not.toContain('Suggests:');
    expect(output).not.toContain('Conflicts:');
    expect(output).not.toContain('Replaces:');
    expect(output).not.toContain('Provides:');
    expect(output).not.toContain('Section:');
    expect(output).not.toContain('Homepage:');
  });

  it('handles multi-line descriptions', () => {
    const entry = createPackageEntry({
      controlData: createControlData({
        description: 'Short summary\nThis is a longer description\nthat spans multiple lines.',
      }),
    });
    const output = generatePackageEntry(entry);

    expect(output).toContain('Description: Short summary');
    expect(output).toContain(' This is a longer description');
    expect(output).toContain(' that spans multiple lines.');
  });

  it('handles empty lines in description with dot', () => {
    const entry = createPackageEntry({
      controlData: createControlData({
        description: 'Summary\n\nParagraph after blank line.',
      }),
    });
    const output = generatePackageEntry(entry);

    expect(output).toContain('Description: Summary');
    expect(output).toContain(' .');
    expect(output).toContain(' Paragraph after blank line.');
  });
});

// ============================================================================
// generatePackagesFile Tests
// ============================================================================

describe('generatePackagesFile', () => {
  it('generates single entry with trailing newline', () => {
    const entries = [createPackageEntry()];
    const output = generatePackagesFile(entries);

    expect(output).toContain('Package: test-pkg');
    expect(output.endsWith('\n')).toBe(true);
  });

  it('generates multiple entries separated by blank lines', () => {
    const entries = [
      createPackageEntry({ controlData: createControlData({ package: 'pkg1' }) }),
      createPackageEntry({ controlData: createControlData({ package: 'pkg2' }) }),
      createPackageEntry({ controlData: createControlData({ package: 'pkg3' }) }),
    ];
    const output = generatePackagesFile(entries);

    expect(output).toContain('Package: pkg1');
    expect(output).toContain('Package: pkg2');
    expect(output).toContain('Package: pkg3');
    // Entries should be separated by double newlines
    expect(output).toContain('\n\n');
  });

  it('handles empty entries list', () => {
    const output = generatePackagesFile([]);
    expect(output).toBe('\n');
  });
});

// ============================================================================
// filterDebAssets Tests
// ============================================================================

describe('filterDebAssets', () => {
  it('filters to only .deb files', () => {
    const assets: AssetLike[] = [
      { name: 'package_1.0.0_amd64.deb', size: 1000, browser_download_url: 'url1' },
      { name: 'package-1.0.0.tar.gz', size: 2000, browser_download_url: 'url2' },
      { name: 'package-1.0.0.x86_64.rpm', size: 3000, browser_download_url: 'url3' },
      { name: 'package_1.0.0_arm64.deb', size: 4000, browser_download_url: 'url4' },
    ];

    const result = filterDebAssets(assets);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('package_1.0.0_amd64.deb');
    expect(result[1].name).toBe('package_1.0.0_arm64.deb');
  });

  it('returns empty array when no .deb files', () => {
    const assets: AssetLike[] = [
      { name: 'package.tar.gz', size: 1000, browser_download_url: 'url1' },
      { name: 'package.rpm', size: 2000, browser_download_url: 'url2' },
    ];

    const result = filterDebAssets(assets);

    expect(result).toHaveLength(0);
  });

  it('handles empty array', () => {
    const result = filterDebAssets([]);
    expect(result).toHaveLength(0);
  });
});

// ============================================================================
// filterByArchitecture Tests
// ============================================================================

describe('filterByArchitecture', () => {
  const assets: AssetLike[] = [
    { name: 'pkg_1.0.0_amd64.deb', size: 1000, browser_download_url: 'url1' },
    { name: 'pkg_1.0.0_arm64.deb', size: 2000, browser_download_url: 'url2' },
    { name: 'pkg_1.0.0_i386.deb', size: 3000, browser_download_url: 'url3' },
    { name: 'pkg_1.0.0_all.deb', size: 4000, browser_download_url: 'url4' },
  ];

  it('returns matching arch plus all packages for specific arch', () => {
    const result = filterByArchitecture(assets, 'amd64');

    expect(result).toHaveLength(2);
    expect(result.map(a => a.name)).toContain('pkg_1.0.0_amd64.deb');
    expect(result.map(a => a.name)).toContain('pkg_1.0.0_all.deb');
  });

  it('returns only all packages when arch is all', () => {
    const result = filterByArchitecture(assets, 'all');

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('pkg_1.0.0_all.deb');
  });

  it('handles arm64 architecture', () => {
    const result = filterByArchitecture(assets, 'arm64');

    expect(result).toHaveLength(2);
    expect(result.map(a => a.name)).toContain('pkg_1.0.0_arm64.deb');
    expect(result.map(a => a.name)).toContain('pkg_1.0.0_all.deb');
  });

  it('handles i386 architecture', () => {
    const result = filterByArchitecture(assets, 'i386');

    expect(result).toHaveLength(2);
    expect(result.map(a => a.name)).toContain('pkg_1.0.0_i386.deb');
    expect(result.map(a => a.name)).toContain('pkg_1.0.0_all.deb');
  });

  it('returns only "all" packages when specific arch not found', () => {
    const result = filterByArchitecture(assets, 'ppc64');

    // Only 'all' packages match when specific arch doesn't exist
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('pkg_1.0.0_all.deb');
  });

  it('returns empty when no matches and no "all" packages exist', () => {
    const assetsNoAll: AssetLike[] = [
      { name: 'pkg_1.0.0_amd64.deb', size: 1000, browser_download_url: 'url1' },
      { name: 'pkg_1.0.0_arm64.deb', size: 2000, browser_download_url: 'url2' },
    ];
    const result = filterByArchitecture(assetsNoAll, 'ppc64');

    expect(result).toHaveLength(0);
  });

  it('handles empty array', () => {
    const result = filterByArchitecture([], 'amd64');
    expect(result).toHaveLength(0);
  });
});

// ============================================================================
// fetchDebMetadata Tests
// ============================================================================

describe('fetchDebMetadata', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws descriptive error on HTTP failure', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    } as Response);

    await expect(fetchDebMetadata('https://example.com/test.deb'))
      .rejects.toThrow('Failed to fetch .deb: 403 Forbidden');
  });

  it('throws on 404 not found', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    } as Response);

    await expect(fetchDebMetadata('https://example.com/test.deb'))
      .rejects.toThrow('Failed to fetch .deb: 404 Not Found');
  });

  it('includes auth token in headers when provided', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    } as Response);

    try {
      await fetchDebMetadata('https://example.com/test.deb', 'test-token');
    } catch {
      // Expected to fail, we just check the fetch call
    }

    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/test.deb',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'token test-token',
        }),
      })
    );
  });

  it('sends Range header for partial content', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Error',
    } as Response);

    try {
      await fetchDebMetadata('https://example.com/test.deb');
    } catch {
      // Expected to fail
    }

    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/test.deb',
      expect.objectContaining({
        headers: expect.objectContaining({
          Range: 'bytes=0-65535',
        }),
        redirect: 'follow',
      })
    );
  });

  it('accepts 206 Partial Content as success', async () => {
    // Create a minimal valid .deb-like buffer (will fail parsing but proves status handling)
    vi.mocked(fetch).mockResolvedValue({
      ok: true, // 206 is in 200-299 range, so ok=true per Fetch spec
      status: 206,
      statusText: 'Partial Content',
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    } as Response);

    // Will fail on parsing, but should not fail on status check
    await expect(fetchDebMetadata('https://example.com/test.deb'))
      .rejects.not.toThrow('Failed to fetch .deb: 206');
  });
});
