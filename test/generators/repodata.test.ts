import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildRepomd,
  generatePrimaryXml,
  generateFilelistsXml,
  generateOtherXml,
  filterRpmAssets,
  buildRpmPackageEntry,
  type RepomdFileInfo,
} from '../../src/generators/repodata';
import type { RpmPackageEntry, RpmHeaderData, GitHubAsset } from '../../src/types';
import { gzipCompress } from '../../src/utils/crypto';

// ============================================================================
// Test Helpers
// ============================================================================

function createRpmHeaderData(overrides: Partial<RpmHeaderData> = {}): RpmHeaderData {
  return {
    name: 'test-package',
    version: '1.0.0',
    release: '1',
    arch: 'x86_64',
    epoch: 0,
    summary: 'Test package summary',
    description: 'Test package description',
    license: 'MIT',
    url: 'https://example.com',
    vendor: 'Test Vendor',
    packager: 'Test Packager',
    group: 'Development/Tools',
    sourceRpm: 'test-package-1.0.0-1.src.rpm',
    buildTime: 1700000000,
    installedSize: 1024000,
    requires: [],
    requireVersions: [],
    requireFlags: [],
    provides: [],
    provideVersions: [],
    provideFlags: [],
    conflicts: [],
    conflictVersions: [],
    conflictFlags: [],
    obsoletes: [],
    obsoleteVersions: [],
    obsoleteFlags: [],
    files: [],
    primaryFiles: [],
    changelog: [],
    ...overrides,
  };
}

function createRpmPackageEntry(overrides: Partial<RpmPackageEntry> = {}): RpmPackageEntry {
  return {
    headerData: createRpmHeaderData(overrides.headerData),
    filename: 'test-package-1.0.0-1.x86_64.rpm',
    size: 123456,
    checksum: 'abc123def456789',
    checksumType: 'sha256',
    ...overrides,
  };
}

async function createRepomdFileInfo(): Promise<RepomdFileInfo> {
  const primaryXml = '<?xml version="1.0"?><metadata packages="0"></metadata>';
  const filelistsXml = '<?xml version="1.0"?><filelists packages="0"></filelists>';
  const otherXml = '<?xml version="1.0"?><otherdata packages="0"></otherdata>';

  return {
    primary: {
      xml: primaryXml,
      gz: await gzipCompress(primaryXml),
    },
    filelists: {
      xml: filelistsXml,
      gz: await gzipCompress(filelistsXml),
    },
    other: {
      xml: otherXml,
      gz: await gzipCompress(otherXml),
    },
    timestamp: 1700000000, // Fixed timestamp for deterministic tests
  };
}

// ============================================================================
// buildRepomd Tests
// ============================================================================

describe('buildRepomd', () => {
  it('generates valid XML structure', async () => {
    const files = await createRepomdFileInfo();
    const { xml } = await buildRepomd(files);

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<repomd xmlns="http://linux.duke.edu/metadata/repo"');
    expect(xml).toContain('</repomd>');
  });

  it('includes revision timestamp', async () => {
    const files = await createRepomdFileInfo();
    const { xml } = await buildRepomd(files);

    expect(xml).toMatch(/<revision>\d+<\/revision>/);
  });

  it('includes primary data section with hash-prefixed location', async () => {
    const files = await createRepomdFileInfo();
    const { xml } = await buildRepomd(files);

    expect(xml).toContain('<data type="primary">');
    expect(xml).toMatch(/<location href="repodata\/[0-9a-f]{64}-primary\.xml\.gz"\/>/);
    expect(xml).toContain('<checksum type="sha256">');
    expect(xml).toContain('<open-checksum type="sha256">');
  });

  it('includes filelists data section with hash-prefixed location', async () => {
    const files = await createRepomdFileInfo();
    const { xml } = await buildRepomd(files);

    expect(xml).toContain('<data type="filelists">');
    expect(xml).toMatch(/<location href="repodata\/[0-9a-f]{64}-filelists\.xml\.gz"\/>/);
  });

  it('includes other data section with hash-prefixed location', async () => {
    const files = await createRepomdFileInfo();
    const { xml } = await buildRepomd(files);

    expect(xml).toContain('<data type="other">');
    expect(xml).toMatch(/<location href="repodata\/[0-9a-f]{64}-other\.xml\.gz"\/>/);
  });

  it('location hash matches the compressed-file checksum', async () => {
    // The SHA256 used in the <location> href is the same as the <checksum>
    // for that section — this is what makes the file content-addressed.
    const files = await createRepomdFileInfo();
    const { xml } = await buildRepomd(files);

    const primaryMatch = xml.match(
      /<data type="primary">[\s\S]*?<checksum type="sha256">([0-9a-f]{64})<\/checksum>[\s\S]*?<location href="repodata\/([0-9a-f]{64})-primary\.xml\.gz"\/>/
    );
    expect(primaryMatch).not.toBeNull();
    expect(primaryMatch![1]).toBe(primaryMatch![2]);
  });

  it('returns hashes matching the embedded <location> paths', async () => {
    const files = await createRepomdFileInfo();
    const { xml, hashes } = await buildRepomd(files);

    expect(xml).toContain(`repodata/${hashes.primary.gz}-primary.xml.gz`);
    expect(xml).toContain(`repodata/${hashes.filelists.gz}-filelists.xml.gz`);
    expect(xml).toContain(`repodata/${hashes.other.gz}-other.xml.gz`);
  });

  it('includes size and open-size for each section', async () => {
    const files = await createRepomdFileInfo();
    const { xml } = await buildRepomd(files);

    // Should have size tags for compressed files
    expect(xml).toMatch(/<size>\d+<\/size>/);
    // Should have open-size tags for uncompressed files
    expect(xml).toMatch(/<open-size>\d+<\/open-size>/);
  });

  it('calculates correct checksums', async () => {
    const files = await createRepomdFileInfo();
    const { xml } = await buildRepomd(files);

    // Checksums should be 64 hex characters (SHA256)
    const checksumMatches = xml.match(/<checksum type="sha256">([0-9a-f]+)<\/checksum>/g);
    expect(checksumMatches).toHaveLength(3);

    const openChecksumMatches = xml.match(/<open-checksum type="sha256">([0-9a-f]+)<\/open-checksum>/g);
    expect(openChecksumMatches).toHaveLength(3);
  });

  it('includes timestamp for each section', async () => {
    const files = await createRepomdFileInfo();
    const { xml } = await buildRepomd(files);

    const timestampMatches = xml.match(/<timestamp>\d+<\/timestamp>/g);
    expect(timestampMatches).toHaveLength(3);
  });
});

// ============================================================================
// generatePrimaryXml Tests
// ============================================================================

describe('generatePrimaryXml', () => {
  it('generates valid XML structure with package count', () => {
    const packages = [createRpmPackageEntry()];
    const output = generatePrimaryXml(packages);

    expect(output).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(output).toContain('<metadata xmlns="http://linux.duke.edu/metadata/common"');
    expect(output).toContain('packages="1"');
    expect(output).toContain('</metadata>');
  });

  it('handles empty package list', () => {
    const output = generatePrimaryXml([]);

    expect(output).toContain('packages="0"');
    expect(output).toContain('<metadata');
    expect(output).toContain('</metadata>');
  });

  it('includes package name and architecture', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({ name: 'my-app', arch: 'aarch64' }),
    })];
    const output = generatePrimaryXml(packages);

    expect(output).toContain('<name>my-app</name>');
    expect(output).toContain('<arch>aarch64</arch>');
  });

  it('includes version with epoch, ver, and rel', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({ epoch: 1, version: '2.3.4', release: '5.fc39' }),
    })];
    const output = generatePrimaryXml(packages);

    expect(output).toContain('epoch="1"');
    expect(output).toContain('ver="2.3.4"');
    expect(output).toContain('rel="5.fc39"');
  });

  it('includes checksum with pkgid', () => {
    const packages = [createRpmPackageEntry({
      checksum: 'deadbeef123456',
      checksumType: 'sha256',
    })];
    const output = generatePrimaryXml(packages);

    expect(output).toContain('<checksum type="sha256" pkgid="YES">deadbeef123456</checksum>');
  });

  it('includes summary and description', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({
        summary: 'A test summary',
        description: 'A longer description',
      }),
    })];
    const output = generatePrimaryXml(packages);

    expect(output).toContain('<summary>A test summary</summary>');
    expect(output).toContain('<description>A longer description</description>');
  });

  it('includes package location', () => {
    const packages = [createRpmPackageEntry({
      filename: 'my-app-1.0.0-1.x86_64.rpm',
    })];
    const output = generatePrimaryXml(packages);

    expect(output).toContain('<location href="Packages/my-app-1.0.0-1.x86_64.rpm"/>');
  });

  it('includes format section with license and vendor', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({
        license: 'Apache-2.0',
        vendor: 'My Company',
      }),
    })];
    const output = generatePrimaryXml(packages);

    expect(output).toContain('<rpm:license>Apache-2.0</rpm:license>');
    expect(output).toContain('<rpm:vendor>My Company</rpm:vendor>');
  });

  it('includes requires entries without version when flags are zero', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({
        requires: ['libc.so.6', 'libssl.so.3'],
        requireVersions: ['', ''],
        requireFlags: [0, 0],
      }),
    })];
    const output = generatePrimaryXml(packages);

    expect(output).toContain('<rpm:requires>');
    expect(output).toContain('<rpm:entry name="libc.so.6"/>');
    expect(output).toContain('<rpm:entry name="libssl.so.3"/>');
    expect(output).toContain('</rpm:requires>');
  });

  it('includes requires entries with version constraints', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({
        requires: ['rpmlib(CompressedFileNames)', 'rpmlib(FileDigests)', 'openssl'],
        requireVersions: ['3.0.4-1', '4.6.0-1', '1.1.0'],
        requireFlags: [0x0A, 0x0A, 0x0C], // LE, LE, GE
      }),
    })];
    const output = generatePrimaryXml(packages);

    expect(output).toContain('<rpm:requires>');
    expect(output).toContain('<rpm:entry name="rpmlib(CompressedFileNames)" flags="LE" epoch="0" ver="3.0.4-1"/>');
    expect(output).toContain('<rpm:entry name="rpmlib(FileDigests)" flags="LE" epoch="0" ver="4.6.0-1"/>');
    expect(output).toContain('<rpm:entry name="openssl" flags="GE" epoch="0" ver="1.1.0"/>');
  });

  it('includes pre attribute for pre-requirement entries', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({
        requires: ['setup'],
        requireVersions: ['2.0'],
        requireFlags: [0x0C | 0x40], // GE | PREREQ
      }),
    })];
    const output = generatePrimaryXml(packages);

    expect(output).toContain('<rpm:entry name="setup" flags="GE" epoch="0" ver="2.0" pre="1"/>');
  });

  it('handles epoch in version string', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({
        requires: ['pkg-with-epoch'],
        requireVersions: ['2:3.0-1'],
        requireFlags: [0x08], // EQ
      }),
    })];
    const output = generatePrimaryXml(packages);

    expect(output).toContain('<rpm:entry name="pkg-with-epoch" flags="EQ" epoch="2" ver="3.0-1"/>');
  });

  it('includes provides entries with version constraints', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({
        provides: ['my-app', 'my-app(x86-64)'],
        provideVersions: ['1.0.0-1', '1.0.0-1'],
        provideFlags: [0x08, 0x08], // EQ
      }),
    })];
    const output = generatePrimaryXml(packages);

    expect(output).toContain('<rpm:provides>');
    expect(output).toContain('<rpm:entry name="my-app" flags="EQ" epoch="0" ver="1.0.0-1"/>');
    expect(output).toContain('<rpm:entry name="my-app(x86-64)" flags="EQ" epoch="0" ver="1.0.0-1"/>');
    expect(output).toContain('</rpm:provides>');
  });

  it('includes provides entries without version when flags are zero', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({
        provides: ['my-app'],
        provideVersions: [''],
        provideFlags: [0],
      }),
    })];
    const output = generatePrimaryXml(packages);

    expect(output).toContain('<rpm:entry name="my-app"/>');
  });

  it('omits requires section when empty', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({ requires: [] }),
    })];
    const output = generatePrimaryXml(packages);

    expect(output).not.toContain('<rpm:requires>');
  });

  it('includes conflicts and obsoletes sections when present', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({
        conflicts: ['old-pkg'],
        conflictVersions: ['1.0'],
        conflictFlags: [0x02], // LT
        obsoletes: ['deprecated-pkg'],
        obsoleteVersions: ['2.0'],
        obsoleteFlags: [0x0A], // LE
      }),
    })];
    const output = generatePrimaryXml(packages);

    expect(output).toContain('<rpm:conflicts>');
    expect(output).toContain('<rpm:entry name="old-pkg" flags="LT" epoch="0" ver="1.0"/>');
    expect(output).toContain('<rpm:obsoletes>');
    expect(output).toContain('<rpm:entry name="deprecated-pkg" flags="LE" epoch="0" ver="2.0"/>');
  });

  it('escapes XML special characters', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({
        name: 'pkg-with-<special>&"chars\'',
        summary: 'Contains <xml> & "quotes"',
      }),
    })];
    const output = generatePrimaryXml(packages);

    expect(output).toContain('&lt;special&gt;&amp;&quot;chars&apos;');
    expect(output).toContain('Contains &lt;xml&gt; &amp; &quot;quotes&quot;');
  });

  it('handles multiple packages', () => {
    const packages = [
      createRpmPackageEntry({ headerData: createRpmHeaderData({ name: 'pkg1' }) }),
      createRpmPackageEntry({ headerData: createRpmHeaderData({ name: 'pkg2' }) }),
      createRpmPackageEntry({ headerData: createRpmHeaderData({ name: 'pkg3' }) }),
    ];
    const output = generatePrimaryXml(packages);

    expect(output).toContain('packages="3"');
    expect(output).toContain('<name>pkg1</name>');
    expect(output).toContain('<name>pkg2</name>');
    expect(output).toContain('<name>pkg3</name>');
  });

  it('emits <file> entries inside <format> for primary-file paths', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({
        primaryFiles: ['/usr/bin/myapp', '/etc/myapp.conf'],
      }),
    })];
    const output = generatePrimaryXml(packages);

    expect(output).toContain('<file>/usr/bin/myapp</file>');
    expect(output).toContain('<file>/etc/myapp.conf</file>');
    // <file> must sit inside <format>
    const formatBlock = output.match(/<format>[\s\S]*?<\/format>/)?.[0] ?? '';
    expect(formatBlock).toContain('<file>/usr/bin/myapp</file>');
  });

  it('orders <file> entries before <rpm:provides>', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({
        primaryFiles: ['/usr/bin/myapp'],
        provides: ['myapp'],
        provideVersions: ['1.0'],
        provideFlags: [0x08],
      }),
    })];
    const output = generatePrimaryXml(packages);

    const fileIdx = output.indexOf('<file>/usr/bin/myapp</file>');
    const providesIdx = output.indexOf('<rpm:provides>');
    expect(fileIdx).toBeGreaterThan(-1);
    expect(providesIdx).toBeGreaterThan(-1);
    expect(fileIdx).toBeLessThan(providesIdx);
  });

  it('escapes special characters in <file> paths', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({
        primaryFiles: ['/usr/bin/weird & name'],
      }),
    })];
    const output = generatePrimaryXml(packages);

    expect(output).toContain('<file>/usr/bin/weird &amp; name</file>');
  });

  it('omits <file> elements when primaryFiles is empty', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({ primaryFiles: [] }),
    })];
    const output = generatePrimaryXml(packages);

    expect(output).not.toContain('<file>');
  });
});

// ============================================================================
// generateFilelistsXml Tests
// ============================================================================

describe('generateFilelistsXml', () => {
  it('generates valid XML structure', () => {
    const packages = [createRpmPackageEntry()];
    const output = generateFilelistsXml(packages);

    expect(output).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(output).toContain('<filelists xmlns="http://linux.duke.edu/metadata/filelists"');
    expect(output).toContain('packages="1"');
    expect(output).toContain('</filelists>');
  });

  it('handles empty package list', () => {
    const output = generateFilelistsXml([]);

    expect(output).toContain('packages="0"');
  });

  it('includes package identity', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({ name: 'my-app', arch: 'aarch64' }),
    })];
    const output = generateFilelistsXml(packages);

    expect(output).toContain('name="my-app"');
    expect(output).toContain('arch="aarch64"');
  });

  it('includes version information', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({ epoch: 2, version: '3.0', release: '1' }),
    })];
    const output = generateFilelistsXml(packages);

    expect(output).toContain('epoch="2"');
    expect(output).toContain('ver="3.0"');
    expect(output).toContain('rel="1"');
  });

  it('includes file entries', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({
        files: ['/usr/bin/myapp', '/usr/share/myapp/config.yml', '/etc/myapp.conf'],
      }),
    })];
    const output = generateFilelistsXml(packages);

    expect(output).toContain('<file>/usr/bin/myapp</file>');
    expect(output).toContain('<file>/usr/share/myapp/config.yml</file>');
    expect(output).toContain('<file>/etc/myapp.conf</file>');
  });

  it('handles packages with no files', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({ files: [] }),
    })];
    const output = generateFilelistsXml(packages);

    expect(output).toContain('<package');
    expect(output).not.toContain('<file>');
  });

  it('escapes special characters in file paths', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({
        files: ['/usr/share/doc/README & Notes.txt'],
      }),
    })];
    const output = generateFilelistsXml(packages);

    expect(output).toContain('<file>/usr/share/doc/README &amp; Notes.txt</file>');
  });
});

// ============================================================================
// generateOtherXml Tests
// ============================================================================

describe('generateOtherXml', () => {
  it('generates valid XML structure', () => {
    const packages = [createRpmPackageEntry()];
    const output = generateOtherXml(packages);

    expect(output).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(output).toContain('<otherdata xmlns="http://linux.duke.edu/metadata/other"');
    expect(output).toContain('packages="1"');
    expect(output).toContain('</otherdata>');
  });

  it('handles empty package list', () => {
    const output = generateOtherXml([]);

    expect(output).toContain('packages="0"');
  });

  it('includes package identity and version', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({
        name: 'changelog-pkg',
        arch: 'noarch',
        epoch: 0,
        version: '1.2.3',
        release: '4',
      }),
    })];
    const output = generateOtherXml(packages);

    expect(output).toContain('name="changelog-pkg"');
    expect(output).toContain('arch="noarch"');
    expect(output).toContain('epoch="0"');
    expect(output).toContain('ver="1.2.3"');
    expect(output).toContain('rel="4"');
  });

  it('includes changelog entries', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({
        changelog: [
          { time: 1700000000, author: 'dev@example.com', text: 'Initial release' },
          { time: 1700100000, author: 'dev@example.com', text: 'Bug fix update' },
        ],
      }),
    })];
    const output = generateOtherXml(packages);

    expect(output).toContain('<changelog author="dev@example.com" date="1700000000">Initial release</changelog>');
    expect(output).toContain('<changelog author="dev@example.com" date="1700100000">Bug fix update</changelog>');
  });

  it('handles packages with no changelog', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({ changelog: [] }),
    })];
    const output = generateOtherXml(packages);

    expect(output).toContain('<package');
    expect(output).not.toContain('<changelog');
  });

  it('escapes special characters in changelog', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({
        changelog: [
          { time: 1700000000, author: 'John "Dev" <dev@example.com>', text: 'Fixed bug & improved <performance>' },
        ],
      }),
    })];
    const output = generateOtherXml(packages);

    expect(output).toContain('author="John &quot;Dev&quot; &lt;dev@example.com&gt;"');
    expect(output).toContain('Fixed bug &amp; improved &lt;performance&gt;');
  });
});

// ============================================================================
// filterRpmAssets Tests
// ============================================================================

describe('filterRpmAssets', () => {
  it('filters to only .rpm files with valid digest', () => {
    const assets: GitHubAsset[] = [
      { id: 1, name: 'package-1.0.0-1.x86_64.rpm', size: 1000, browser_download_url: 'url1', digest: 'sha256:abc123' },
      { id: 2, name: 'package-1.0.0.tar.gz', size: 2000, browser_download_url: 'url2', digest: 'sha256:def456' },
      { id: 3, name: 'package_1.0.0_amd64.deb', size: 3000, browser_download_url: 'url3', digest: 'sha256:ghi789' },
      { id: 4, name: 'package-1.0.0-1.aarch64.rpm', size: 4000, browser_download_url: 'url4', digest: 'sha256:jkl012' },
    ];

    const result = filterRpmAssets(assets);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('package-1.0.0-1.x86_64.rpm');
    expect(result[1].name).toBe('package-1.0.0-1.aarch64.rpm');
  });

  it('excludes source RPMs (.src.rpm)', () => {
    const assets: GitHubAsset[] = [
      { id: 1, name: 'package-1.0.0-1.x86_64.rpm', size: 1000, browser_download_url: 'url1', digest: 'sha256:abc123' },
      { id: 2, name: 'package-1.0.0-1.src.rpm', size: 5000, browser_download_url: 'url2', digest: 'sha256:def456' },
    ];

    const result = filterRpmAssets(assets);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('package-1.0.0-1.x86_64.rpm');
  });

  it('includes nosrc RPMs (only .src.rpm is excluded)', () => {
    const assets: GitHubAsset[] = [
      { id: 1, name: 'package-1.0.0-1.nosrc.rpm', size: 6000, browser_download_url: 'url1', digest: 'sha256:abc123' },
    ];

    const result = filterRpmAssets(assets);

    // Note: nosrc RPMs are not excluded by current implementation
    expect(result).toHaveLength(1);
  });

  it('returns empty array when no .rpm files', () => {
    const assets: GitHubAsset[] = [
      { id: 1, name: 'package.tar.gz', size: 1000, browser_download_url: 'url1', digest: 'sha256:abc123' },
      { id: 2, name: 'package.deb', size: 2000, browser_download_url: 'url2', digest: 'sha256:def456' },
    ];

    const result = filterRpmAssets(assets);

    expect(result).toHaveLength(0);
  });

  it('handles empty array', () => {
    const result = filterRpmAssets([]);
    expect(result).toHaveLength(0);
  });

  it('handles real-world filenames', () => {
    const assets: GitHubAsset[] = [
      { id: 1, name: 'go-hass-agent-11.2.0-1.x86_64.rpm', size: 1000, browser_download_url: 'url1', digest: 'sha256:abc' },
      { id: 2, name: 'go-hass-agent-11.2.0-1.aarch64.rpm', size: 1000, browser_download_url: 'url2', digest: 'sha256:def' },
      { id: 3, name: 'obsidian-1.5.12-1.x86_64.rpm', size: 2000, browser_download_url: 'url3', digest: 'sha256:ghi' },
      { id: 4, name: 'LocalSend-1.14.0-1.linux.x86_64.rpm', size: 3000, browser_download_url: 'url4', digest: 'sha256:jkl' },
    ];

    const result = filterRpmAssets(assets);

    expect(result).toHaveLength(4);
  });

  it('preserves asset type', () => {
    interface ExtendedAsset extends GitHubAsset {
      extra: string;
    }

    const assets: ExtendedAsset[] = [
      { id: 123, name: 'pkg.rpm', size: 100, browser_download_url: 'url', digest: 'sha256:abc123', extra: 'marker' },
    ];

    const result = filterRpmAssets(assets);

    expect(result).toHaveLength(1);
    expect(result[0].extra).toBe('marker');
  });

  it('excludes assets without digest', () => {
    const assets: GitHubAsset[] = [
      { id: 1, name: 'package-1.0.0-1.x86_64.rpm', size: 1000, browser_download_url: 'url1', digest: 'sha256:abc123' },
      { id: 2, name: 'package-1.0.0-1.aarch64.rpm', size: 2000, browser_download_url: 'url2' }, // no digest
      { id: 3, name: 'package-1.0.0-1.i686.rpm', size: 3000, browser_download_url: 'url3', digest: undefined },
    ];

    const result = filterRpmAssets(assets);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('package-1.0.0-1.x86_64.rpm');
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('repodata integration', () => {
  it('generates consistent metadata across all XML files', () => {
    const packages = [
      createRpmPackageEntry({
        headerData: createRpmHeaderData({
          name: 'test-pkg',
          version: '1.0.0',
          release: '1',
          arch: 'x86_64',
          epoch: 0,
        }),
      }),
    ];

    const primary = generatePrimaryXml(packages);
    const filelists = generateFilelistsXml(packages);
    const other = generateOtherXml(packages);

    // All should have same package count
    expect(primary).toContain('packages="1"');
    expect(filelists).toContain('packages="1"');
    expect(other).toContain('packages="1"');

    // All should reference same package
    expect(primary).toContain('<name>test-pkg</name>');
    expect(filelists).toContain('name="test-pkg"');
    expect(other).toContain('name="test-pkg"');

    // All should have consistent version info
    expect(primary).toContain('epoch="0"');
    expect(filelists).toContain('epoch="0"');
    expect(other).toContain('epoch="0"');
  });

  it('all generated XML is well-formed', () => {
    const packages = [createRpmPackageEntry()];

    const primary = generatePrimaryXml(packages);
    const filelists = generateFilelistsXml(packages);
    const other = generateOtherXml(packages);

    // Check for matching open/close tags
    expect(primary).toMatch(/<metadata[^>]*>[\s\S]*<\/metadata>/);
    expect(filelists).toMatch(/<filelists[^>]*>[\s\S]*<\/filelists>/);
    expect(other).toMatch(/<otherdata[^>]*>[\s\S]*<\/otherdata>/);

    // Check for proper XML declaration
    expect(primary).toMatch(/^<\?xml version="1\.0"/);
    expect(filelists).toMatch(/^<\?xml version="1\.0"/);
    expect(other).toMatch(/^<\?xml version="1\.0"/);
  });
});

// ============================================================================
// buildRpmPackageEntry truncation / retry tests
// ============================================================================

/**
 * Minimum viable RPM: lead + empty signature header + main header with the
 * requested tags. Returns a Uint8Array of the complete file.
 */
function buildMinimalRpm(
  tags: { tag: number; type: number; value: string | number | string[] | number[] }[],
): Uint8Array {
  const RPM_MAGIC = [0xed, 0xab, 0xee, 0xdb];
  const HEADER_MAGIC = [0x8e, 0xad, 0xe8];

  const lead = new Uint8Array(96);
  lead[0] = RPM_MAGIC[0]; lead[1] = RPM_MAGIC[1];
  lead[2] = RPM_MAGIC[2]; lead[3] = RPM_MAGIC[3];
  lead[4] = 3;

  function makeHeader(hdrTags: typeof tags): Uint8Array {
    let dataSize = 0;
    const idx: { tag: number; type: number; offset: number; count: number }[] = [];
    for (const { tag, type, value } of hdrTags) {
      const off = dataSize;
      let count = 1;
      if (type === 6) dataSize += (value as string).length + 1;
      else if (type === 8) {
        count = (value as string[]).length;
        for (const s of value as string[]) dataSize += s.length + 1;
      } else if (type === 4) {
        if (Array.isArray(value)) { count = value.length; dataSize += 4 * count; }
        else dataSize += 4;
      }
      idx.push({ tag, type, offset: off, count });
    }
    const nindex = idx.length;
    const total = 16 + nindex * 16 + dataSize;
    const buf = new Uint8Array(total);
    const dv = new DataView(buf.buffer);
    buf[0] = HEADER_MAGIC[0]; buf[1] = HEADER_MAGIC[1]; buf[2] = HEADER_MAGIC[2]; buf[3] = 1;
    dv.setUint32(8, nindex, false);
    dv.setUint32(12, dataSize, false);
    for (let i = 0; i < nindex; i++) {
      const e = idx[i];
      const o = 16 + i * 16;
      dv.setUint32(o, e.tag, false);
      dv.setUint32(o + 4, e.type, false);
      dv.setUint32(o + 8, e.offset, false);
      dv.setUint32(o + 12, e.count, false);
    }
    const dataStart = 16 + nindex * 16;
    let dataOff = 0;
    for (const { type, value } of hdrTags) {
      if (type === 6) {
        const s = value as string;
        buf.set(new TextEncoder().encode(s), dataStart + dataOff);
        dataOff += s.length + 1;
      } else if (type === 8) {
        for (const s of value as string[]) {
          buf.set(new TextEncoder().encode(s), dataStart + dataOff);
          dataOff += s.length + 1;
        }
      } else if (type === 4) {
        const arr = Array.isArray(value) ? value as number[] : [value as number];
        for (const v of arr) { dv.setUint32(dataStart + dataOff, v, false); dataOff += 4; }
      }
    }
    return buf;
  }

  const sigHdr = makeHeader([]);
  const sigPad = (8 - (sigHdr.length % 8)) % 8;
  const mainHdr = makeHeader(tags);

  const total = lead.length + sigHdr.length + sigPad + mainHdr.length;
  const out = new Uint8Array(total);
  out.set(lead, 0);
  out.set(sigHdr, lead.length);
  out.set(mainHdr, lead.length + sigHdr.length + sigPad);
  return out;
}

describe('buildRpmPackageEntry range retry on truncation', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const asset: GitHubAsset = {
    id: 1,
    name: 'big-pkg-1.0-1.x86_64.rpm',
    size: 999999,
    browser_download_url: 'https://example.com/big-pkg.rpm',
    digest: 'sha256:deadbeef',
  };

  it('retries with a larger range when the 256KB window is truncated', async () => {
    // Build an RPM whose total size exceeds the 256KB range but fits in 1MB.
    // A giant SUMMARY pushes the declared header data past 256KB.
    const bigPad = 'x'.repeat(400_000);
    const fullRpm = buildMinimalRpm([
      { tag: 1000, type: 6, value: 'big-pkg' },
      { tag: 1001, type: 6, value: '1.0' },
      { tag: 1002, type: 6, value: '1' },
      { tag: 1022, type: 6, value: 'x86_64' },
      { tag: 1004, type: 6, value: bigPad },
    ]);

    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const range = (init?.headers as Record<string, string> | undefined)?.['Range'] ?? '';
      const m = range.match(/bytes=0-(\d+)/);
      const end = m ? parseInt(m[1], 10) : fullRpm.length - 1;
      const slice = fullRpm.slice(0, Math.min(end + 1, fullRpm.length));
      return new Response(slice, { status: 206 });
    });

    const entry = await buildRpmPackageEntry(asset);
    expect(entry).not.toBeNull();
    expect(entry!.headerData.name).toBe('big-pkg');
    // Should have retried at least twice (256KB truncated, 1MB succeeded).
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('drops the asset and returns null when header exceeds the 4MB cap', async () => {
    // Declare a header hsize that exceeds our 4MB ceiling so every retry fails.
    // Use a truncated buffer where the main header's declared size is huge.
    const lead = new Uint8Array(96);
    lead[0] = 0xed; lead[1] = 0xab; lead[2] = 0xee; lead[3] = 0xdb; lead[4] = 3;
    // Minimal valid signature header (empty).
    const sig = new Uint8Array(16);
    sig[0] = 0x8e; sig[1] = 0xad; sig[2] = 0xe8; sig[3] = 1;
    const sigPad = (8 - (sig.length % 8)) % 8;
    // Main header declares 5MB of data but provides none.
    const main = new Uint8Array(16);
    const dv = new DataView(main.buffer);
    main[0] = 0x8e; main[1] = 0xad; main[2] = 0xe8; main[3] = 1;
    dv.setUint32(8, 0, false);
    dv.setUint32(12, 5 * 1024 * 1024, false);
    const total = lead.length + sig.length + sigPad + main.length;
    const rpm = new Uint8Array(total);
    rpm.set(lead, 0);
    rpm.set(sig, lead.length);
    rpm.set(main, lead.length + sig.length + sigPad);

    vi.mocked(fetch).mockImplementation(async () => new Response(rpm, { status: 206 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const entry = await buildRpmPackageEntry(asset);
    expect(entry).toBeNull();
    expect(vi.mocked(fetch).mock.calls.length).toBe(3); // 256KB, 1MB, 4MB
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
