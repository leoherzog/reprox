import { describe, it, expect } from 'vitest';
import {
  generateRepomdXml,
  generatePrimaryXml,
  generateFilelistsXml,
  generateOtherXml,
  filterRpmAssets,
  type RepomdFileInfo,
} from '../../src/generators/repodata';
import type { RpmPackageEntry, RpmHeaderData, AssetLike } from '../../src/types';
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
    requires: [],
    provides: [],
    files: [],
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
  };
}

// ============================================================================
// generateRepomdXml Tests
// ============================================================================

describe('generateRepomdXml', () => {
  it('generates valid XML structure', async () => {
    const files = await createRepomdFileInfo();
    const output = await generateRepomdXml(files);

    expect(output).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(output).toContain('<repomd xmlns="http://linux.duke.edu/metadata/repo"');
    expect(output).toContain('</repomd>');
  });

  it('includes revision timestamp', async () => {
    const files = await createRepomdFileInfo();
    const output = await generateRepomdXml(files);

    expect(output).toMatch(/<revision>\d+<\/revision>/);
  });

  it('includes primary data section', async () => {
    const files = await createRepomdFileInfo();
    const output = await generateRepomdXml(files);

    expect(output).toContain('<data type="primary">');
    expect(output).toContain('<location href="repodata/primary.xml.gz"/>');
    expect(output).toContain('<checksum type="sha256">');
    expect(output).toContain('<open-checksum type="sha256">');
  });

  it('includes filelists data section', async () => {
    const files = await createRepomdFileInfo();
    const output = await generateRepomdXml(files);

    expect(output).toContain('<data type="filelists">');
    expect(output).toContain('<location href="repodata/filelists.xml.gz"/>');
  });

  it('includes other data section', async () => {
    const files = await createRepomdFileInfo();
    const output = await generateRepomdXml(files);

    expect(output).toContain('<data type="other">');
    expect(output).toContain('<location href="repodata/other.xml.gz"/>');
  });

  it('includes size and open-size for each section', async () => {
    const files = await createRepomdFileInfo();
    const output = await generateRepomdXml(files);

    // Should have size tags for compressed files
    expect(output).toMatch(/<size>\d+<\/size>/);
    // Should have open-size tags for uncompressed files
    expect(output).toMatch(/<open-size>\d+<\/open-size>/);
  });

  it('calculates correct checksums', async () => {
    const files = await createRepomdFileInfo();
    const output = await generateRepomdXml(files);

    // Checksums should be 64 hex characters (SHA256)
    const checksumMatches = output.match(/<checksum type="sha256">([0-9a-f]+)<\/checksum>/g);
    expect(checksumMatches).toHaveLength(3);

    const openChecksumMatches = output.match(/<open-checksum type="sha256">([0-9a-f]+)<\/open-checksum>/g);
    expect(openChecksumMatches).toHaveLength(3);
  });

  it('includes timestamp for each section', async () => {
    const files = await createRepomdFileInfo();
    const output = await generateRepomdXml(files);

    const timestampMatches = output.match(/<timestamp>\d+<\/timestamp>/g);
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

  it('includes requires entries when present', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({
        requires: ['libc.so.6', 'libssl.so.3'],
      }),
    })];
    const output = generatePrimaryXml(packages);

    expect(output).toContain('<rpm:requires>');
    expect(output).toContain('<rpm:entry name="libc.so.6"/>');
    expect(output).toContain('<rpm:entry name="libssl.so.3"/>');
    expect(output).toContain('</rpm:requires>');
  });

  it('includes provides entries when present', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({
        provides: ['my-app', 'my-app(x86-64)'],
      }),
    })];
    const output = generatePrimaryXml(packages);

    expect(output).toContain('<rpm:provides>');
    expect(output).toContain('<rpm:entry name="my-app"/>');
    expect(output).toContain('<rpm:entry name="my-app(x86-64)"/>');
    expect(output).toContain('</rpm:provides>');
  });

  it('omits requires section when empty', () => {
    const packages = [createRpmPackageEntry({
      headerData: createRpmHeaderData({ requires: [] }),
    })];
    const output = generatePrimaryXml(packages);

    expect(output).not.toContain('<rpm:requires>');
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
  it('filters to only .rpm files', () => {
    const assets: AssetLike[] = [
      { name: 'package-1.0.0-1.x86_64.rpm', size: 1000, browser_download_url: 'url1' },
      { name: 'package-1.0.0.tar.gz', size: 2000, browser_download_url: 'url2' },
      { name: 'package_1.0.0_amd64.deb', size: 3000, browser_download_url: 'url3' },
      { name: 'package-1.0.0-1.aarch64.rpm', size: 4000, browser_download_url: 'url4' },
    ];

    const result = filterRpmAssets(assets);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('package-1.0.0-1.x86_64.rpm');
    expect(result[1].name).toBe('package-1.0.0-1.aarch64.rpm');
  });

  it('excludes source RPMs (.src.rpm)', () => {
    const assets: AssetLike[] = [
      { name: 'package-1.0.0-1.x86_64.rpm', size: 1000, browser_download_url: 'url1' },
      { name: 'package-1.0.0-1.src.rpm', size: 5000, browser_download_url: 'url2' },
    ];

    const result = filterRpmAssets(assets);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('package-1.0.0-1.x86_64.rpm');
  });

  it('includes nosrc RPMs (only .src.rpm is excluded)', () => {
    const assets: AssetLike[] = [
      { name: 'package-1.0.0-1.nosrc.rpm', size: 6000, browser_download_url: 'url1' },
    ];

    const result = filterRpmAssets(assets);

    // Note: nosrc RPMs are not excluded by current implementation
    expect(result).toHaveLength(1);
  });

  it('returns empty array when no .rpm files', () => {
    const assets: AssetLike[] = [
      { name: 'package.tar.gz', size: 1000, browser_download_url: 'url1' },
      { name: 'package.deb', size: 2000, browser_download_url: 'url2' },
    ];

    const result = filterRpmAssets(assets);

    expect(result).toHaveLength(0);
  });

  it('handles empty array', () => {
    const result = filterRpmAssets([]);
    expect(result).toHaveLength(0);
  });

  it('handles real-world filenames', () => {
    const assets: AssetLike[] = [
      { name: 'go-hass-agent-11.2.0-1.x86_64.rpm', size: 1000, browser_download_url: 'url1' },
      { name: 'go-hass-agent-11.2.0-1.aarch64.rpm', size: 1000, browser_download_url: 'url2' },
      { name: 'obsidian-1.5.12-1.x86_64.rpm', size: 2000, browser_download_url: 'url3' },
      { name: 'LocalSend-1.14.0-1.linux.x86_64.rpm', size: 3000, browser_download_url: 'url4' },
    ];

    const result = filterRpmAssets(assets);

    expect(result).toHaveLength(4);
  });

  it('preserves asset type', () => {
    interface ExtendedAsset extends AssetLike {
      id: number;
    }

    const assets: ExtendedAsset[] = [
      { name: 'pkg.rpm', size: 100, browser_download_url: 'url', id: 123 },
    ];

    const result = filterRpmAssets(assets);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(123);
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
