/**
 * RPM Repository Metadata Generator
 *
 * Generates repomd.xml, primary.xml, filelists.xml, and other.xml for RPM/YUM/DNF repositories.
 * Compatible with COPR-style repository structure.
 *
 * Structure:
 * /{owner}/{repo}/repodata/repomd.xml       - Repository metadata index
 * /{owner}/{repo}/repodata/primary.xml.gz   - Package metadata
 * /{owner}/{repo}/repodata/filelists.xml.gz - File listings per package
 * /{owner}/{repo}/repodata/other.xml.gz     - Changelog entries
 * /{owner}/{repo}/Packages/{file}.rpm       - Package files (redirect to GitHub)
 */

import type { RpmPackageEntry, RpmHeaderData, AssetLike } from '../types';
import { sha256, gzipCompress } from '../utils/crypto';
import { extractRpmMetadata, extractRpmArchFromFilename } from '../parsers/rpm';
import { escapeXml } from '../utils/xml';

/**
 * Metadata file info for repomd.xml generation
 */
export interface RepomdFileInfo {
  primary: { xml: string; gz: Uint8Array };
  filelists: { xml: string; gz: Uint8Array };
  other: { xml: string; gz: Uint8Array };
}

/**
 * Generate repomd.xml content referencing all metadata files
 */
export async function generateRepomdXml(files: RepomdFileInfo): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);

  // Calculate checksums for all files
  const [primaryChecksum, primaryGzChecksum] = await Promise.all([
    sha256(files.primary.xml),
    sha256(files.primary.gz),
  ]);
  const [filelistsChecksum, filelistsGzChecksum] = await Promise.all([
    sha256(files.filelists.xml),
    sha256(files.filelists.gz),
  ]);
  const [otherChecksum, otherGzChecksum] = await Promise.all([
    sha256(files.other.xml),
    sha256(files.other.gz),
  ]);

  const primarySize = new TextEncoder().encode(files.primary.xml).length;
  const filelistsSize = new TextEncoder().encode(files.filelists.xml).length;
  const otherSize = new TextEncoder().encode(files.other.xml).length;

  return `<?xml version="1.0" encoding="UTF-8"?>
<repomd xmlns="http://linux.duke.edu/metadata/repo" xmlns:rpm="http://linux.duke.edu/metadata/rpm">
  <revision>${timestamp}</revision>
  <data type="primary">
    <checksum type="sha256">${primaryGzChecksum}</checksum>
    <open-checksum type="sha256">${primaryChecksum}</open-checksum>
    <location href="repodata/primary.xml.gz"/>
    <timestamp>${timestamp}</timestamp>
    <size>${files.primary.gz.length}</size>
    <open-size>${primarySize}</open-size>
  </data>
  <data type="filelists">
    <checksum type="sha256">${filelistsGzChecksum}</checksum>
    <open-checksum type="sha256">${filelistsChecksum}</open-checksum>
    <location href="repodata/filelists.xml.gz"/>
    <timestamp>${timestamp}</timestamp>
    <size>${files.filelists.gz.length}</size>
    <open-size>${filelistsSize}</open-size>
  </data>
  <data type="other">
    <checksum type="sha256">${otherGzChecksum}</checksum>
    <open-checksum type="sha256">${otherChecksum}</open-checksum>
    <location href="repodata/other.xml.gz"/>
    <timestamp>${timestamp}</timestamp>
    <size>${files.other.gz.length}</size>
    <open-size>${otherSize}</open-size>
  </data>
</repomd>
`;
}

/**
 * Generate primary.xml content with package metadata
 */
export function generatePrimaryXml(packages: RpmPackageEntry[]): string {
  const packageEntries = packages.map(generatePackageXml).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<metadata xmlns="http://linux.duke.edu/metadata/common" xmlns:rpm="http://linux.duke.edu/metadata/rpm" packages="${packages.length}">
${packageEntries}
</metadata>
`;
}

/**
 * Generate XML for a single package
 */
function generatePackageXml(pkg: RpmPackageEntry): string {
  const { headerData, filename, size, checksum, checksumType } = pkg;

  // Format version with epoch if present
  const epoch = headerData.epoch || 0;
  const ver = headerData.version;
  const rel = headerData.release;

  // Format requires as XML
  const requiresXml = headerData.requires.length > 0
    ? `    <rpm:requires>\n${headerData.requires.map(r => `      <rpm:entry name="${escapeXml(r)}"/>`).join('\n')}\n    </rpm:requires>`
    : '';

  // Format provides as XML
  const providesXml = headerData.provides.length > 0
    ? `    <rpm:provides>\n${headerData.provides.map(p => `      <rpm:entry name="${escapeXml(p)}"/>`).join('\n')}\n    </rpm:provides>`
    : '';

  return `  <package type="rpm">
    <name>${escapeXml(headerData.name)}</name>
    <arch>${escapeXml(headerData.arch)}</arch>
    <version epoch="${epoch}" ver="${escapeXml(ver)}" rel="${escapeXml(rel)}"/>
    <checksum type="${checksumType}" pkgid="${checksum ? 'YES' : 'NO'}">${checksum}</checksum>
    <summary>${escapeXml(headerData.summary)}</summary>
    <description>${escapeXml(headerData.description)}</description>
    <packager>${escapeXml(headerData.packager || headerData.vendor)}</packager>
    <url>${escapeXml(headerData.url)}</url>
    <time file="${headerData.buildTime}" build="${headerData.buildTime}"/>
    <size package="${size}" installed="0" archive="0"/>
    <location href="Packages/${escapeXml(filename)}"/>
    <format>
      <rpm:license>${escapeXml(headerData.license)}</rpm:license>
      <rpm:vendor>${escapeXml(headerData.vendor)}</rpm:vendor>
      <rpm:group>${escapeXml(headerData.group || 'Unspecified')}</rpm:group>
      <rpm:sourcerpm>${escapeXml(headerData.sourceRpm)}</rpm:sourcerpm>
${requiresXml}
${providesXml}
    </format>
  </package>`;
}

/**
 * Generate filelists.xml content with file listings per package
 */
export function generateFilelistsXml(packages: RpmPackageEntry[]): string {
  const packageEntries = packages.map(generateFilelistPackageXml).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<filelists xmlns="http://linux.duke.edu/metadata/filelists" packages="${packages.length}">
${packageEntries}
</filelists>
`;
}

/**
 * Generate filelists XML for a single package
 */
function generateFilelistPackageXml(pkg: RpmPackageEntry): string {
  const { headerData } = pkg;
  const epoch = headerData.epoch || 0;

  // Generate file entries
  const filesXml = headerData.files.map(f => `    <file>${escapeXml(f)}</file>`).join('\n');

  return `  <package pkgid="${pkg.checksum}" name="${escapeXml(headerData.name)}" arch="${escapeXml(headerData.arch)}">
    <version epoch="${epoch}" ver="${escapeXml(headerData.version)}" rel="${escapeXml(headerData.release)}"/>
${filesXml}
  </package>`;
}

/**
 * Generate other.xml content with changelog entries per package
 */
export function generateOtherXml(packages: RpmPackageEntry[]): string {
  const packageEntries = packages.map(generateOtherPackageXml).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<otherdata xmlns="http://linux.duke.edu/metadata/other" packages="${packages.length}">
${packageEntries}
</otherdata>
`;
}

/**
 * Generate other.xml XML for a single package
 */
function generateOtherPackageXml(pkg: RpmPackageEntry): string {
  const { headerData } = pkg;
  const epoch = headerData.epoch || 0;

  // Generate changelog entries
  const changelogXml = headerData.changelog.map(entry => {
    const date = entry.time;
    return `    <changelog author="${escapeXml(entry.author)}" date="${date}">${escapeXml(entry.text)}</changelog>`;
  }).join('\n');

  return `  <package pkgid="${pkg.checksum}" name="${escapeXml(headerData.name)}" arch="${escapeXml(headerData.arch)}">
    <version epoch="${epoch}" ver="${escapeXml(headerData.version)}" rel="${escapeXml(headerData.release)}"/>
${changelogXml}
  </package>`;
}

/**
 * Build an RpmPackageEntry from a GitHub asset
 * Note: We don't calculate checksum since it requires full download
 */
export async function buildRpmPackageEntry(
  asset: AssetLike,
  githubToken?: string
): Promise<RpmPackageEntry> {
  const headerData = await extractRpmMetadata(asset.browser_download_url, githubToken);

  // Override arch from filename if header doesn't have it
  if (!headerData.arch || headerData.arch === '') {
    headerData.arch = extractRpmArchFromFilename(asset.name);
  }

  return {
    headerData,
    filename: asset.name,
    size: asset.size,
    checksum: '', // Not calculated - would require full download
    checksumType: 'sha256',
  };
}

/**
 * Filter GitHub assets to only .rpm files
 */
export function filterRpmAssets<T extends AssetLike>(assets: T[]): T[] {
  return assets.filter(asset =>
    asset.name.endsWith('.rpm') && !asset.name.includes('.src.rpm')
  );
}
