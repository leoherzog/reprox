/**
 * RPM Repository Metadata Generator
 *
 * Generates repomd.xml, primary.xml, filelists.xml, and other.xml for RPM/YUM/DNF repositories.
 * Compatible with standard YUM/DNF repository structure.
 *
 * Structure:
 * /{owner}/{repo}/repodata/repomd.xml       - Repository metadata index
 * /{owner}/{repo}/repodata/primary.xml.gz   - Package metadata
 * /{owner}/{repo}/repodata/filelists.xml.gz - File listings per package
 * /{owner}/{repo}/repodata/other.xml.gz     - Changelog entries
 * /{owner}/{repo}/Packages/{file}.rpm       - Package files (redirect to GitHub)
 */

import type { RpmPackageEntry, RpmHeaderData, GitHubAsset } from '../types';
import { sha256, gzipCompress } from '../utils/crypto';
import { parseRpmBuffer, RpmHeaderTruncatedError } from '../parsers/rpm';
import { fetchRange } from '../utils/fetch';
import { extractRpmArchFromFilename } from '../utils/architectures';
import { escapeXml } from '../utils/xml';

// Retry ladder for oversized RPM headers. 256KB fits the overwhelming
// majority; the jumps handle packages with enormous file lists. We cap at 4MB
// to avoid pulling the entire payload; anything bigger is dropped with a warn.
const RPM_RANGE_RETRY_LADDER = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024];

/**
 * Metadata file info for repomd.xml generation
 */
export interface RepomdFileInfo {
  primary: { xml: string; gz: Uint8Array };
  filelists: { xml: string; gz: Uint8Array };
  other: { xml: string; gz: Uint8Array };
  timestamp: number; // Unix timestamp from GitHub release for consistency
}

/**
 * Per-section checksums used both inside repomd.xml and as cache blob keys
 */
export interface RepomdSectionHashes {
  xml: string;  // SHA256 of the uncompressed XML
  gz: string;   // SHA256 of the gzipped XML (also used as the filename prefix)
}

export interface RepomdHashes {
  primary: RepomdSectionHashes;
  filelists: RepomdSectionHashes;
  other: RepomdSectionHashes;
}

/**
 * Result of building repomd.xml: the XML itself plus the per-section hashes
 * that were embedded in <location> paths. Callers use the hashes as cache
 * blob keys for the immutable, content-addressed XML files.
 */
export interface RepomdBuildResult {
  xml: string;
  hashes: RepomdHashes;
}

/**
 * Build repomd.xml and return the hashes used in its <location href> paths.
 *
 * Uses unique_md_filenames convention (Fedora/EPEL default since ~2015):
 * each metadata file is named `{sha256}-{type}.xml.gz`. This makes the
 * referenced files content-addressed and immutable, eliminating the race
 * where a client fetches repomd.xml v1 then primary.xml.gz v2.
 */
export async function buildRepomd(files: RepomdFileInfo): Promise<RepomdBuildResult> {
  const timestamp = files.timestamp;

  const [
    primaryXml, primaryGz,
    filelistsXml, filelistsGz,
    otherXml, otherGz,
  ] = await Promise.all([
    sha256(files.primary.xml),
    sha256(files.primary.gz),
    sha256(files.filelists.xml),
    sha256(files.filelists.gz),
    sha256(files.other.xml),
    sha256(files.other.gz),
  ]);

  const hashes: RepomdHashes = {
    primary: { xml: primaryXml, gz: primaryGz },
    filelists: { xml: filelistsXml, gz: filelistsGz },
    other: { xml: otherXml, gz: otherGz },
  };

  const primarySize = new TextEncoder().encode(files.primary.xml).length;
  const filelistsSize = new TextEncoder().encode(files.filelists.xml).length;
  const otherSize = new TextEncoder().encode(files.other.xml).length;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<repomd xmlns="http://linux.duke.edu/metadata/repo" xmlns:rpm="http://linux.duke.edu/metadata/rpm">
  <revision>${timestamp}</revision>
  <data type="primary">
    <checksum type="sha256">${primaryGz}</checksum>
    <open-checksum type="sha256">${primaryXml}</open-checksum>
    <location href="repodata/${primaryGz}-primary.xml.gz"/>
    <timestamp>${timestamp}</timestamp>
    <size>${files.primary.gz.length}</size>
    <open-size>${primarySize}</open-size>
  </data>
  <data type="filelists">
    <checksum type="sha256">${filelistsGz}</checksum>
    <open-checksum type="sha256">${filelistsXml}</open-checksum>
    <location href="repodata/${filelistsGz}-filelists.xml.gz"/>
    <timestamp>${timestamp}</timestamp>
    <size>${files.filelists.gz.length}</size>
    <open-size>${filelistsSize}</open-size>
  </data>
  <data type="other">
    <checksum type="sha256">${otherGz}</checksum>
    <open-checksum type="sha256">${otherXml}</open-checksum>
    <location href="repodata/${otherGz}-other.xml.gz"/>
    <timestamp>${timestamp}</timestamp>
    <size>${files.other.gz.length}</size>
    <open-size>${otherSize}</open-size>
  </data>
</repomd>
`;

  return { xml, hashes };
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

// RPM dependency flag bitmasks
const RPMSENSE_LESS    = 0x02;
const RPMSENSE_GREATER = 0x04;
const RPMSENSE_EQUAL   = 0x08;
// Pre-requirement flags
const RPMSENSE_PREREQ        = 0x40;
const RPMSENSE_SCRIPT_PRE    = 0x200;
const RPMSENSE_SCRIPT_POST   = 0x400;
const RPMSENSE_SCRIPT_PREUN  = 0x800;
const RPMSENSE_SCRIPT_POSTUN = 0x1000;
const RPMSENSE_PRE_MASK = RPMSENSE_PREREQ | RPMSENSE_SCRIPT_PRE | RPMSENSE_SCRIPT_POST | RPMSENSE_SCRIPT_PREUN | RPMSENSE_SCRIPT_POSTUN;

/**
 * Convert RPM flag bitmask to the string used in primary.xml
 */
function rpmFlagsToString(flags: number): string {
  const cmp = flags & (RPMSENSE_LESS | RPMSENSE_GREATER | RPMSENSE_EQUAL);
  switch (cmp) {
    case RPMSENSE_LESS | RPMSENSE_EQUAL: return 'LE';
    case RPMSENSE_GREATER | RPMSENSE_EQUAL: return 'GE';
    case RPMSENSE_EQUAL: return 'EQ';
    case RPMSENSE_LESS: return 'LT';
    case RPMSENSE_GREATER: return 'GT';
    default: return '';
  }
}

/**
 * Format a single rpm:entry element with optional version constraint and pre attribute
 */
function formatRpmEntry(name: string, flags: number, version: string): string {
  const flagStr = rpmFlagsToString(flags);
  const isPre = (flags & RPMSENSE_PRE_MASK) !== 0;

  let entry = `      <rpm:entry name="${escapeXml(name)}"`;

  if (flagStr && version) {
    // Parse epoch from version string (format: "epoch:ver-rel" or just "ver-rel")
    let epoch = '0';
    let ver = version;
    const colonIdx = version.indexOf(':');
    if (colonIdx !== -1) {
      epoch = version.slice(0, colonIdx);
      ver = version.slice(colonIdx + 1);
    }
    entry += ` flags="${flagStr}" epoch="${epoch}" ver="${escapeXml(ver)}"`;
  }

  if (isPre) {
    entry += ` pre="1"`;
  }

  entry += '/>';
  return entry;
}

/**
 * Format a dependency section (requires, provides, conflicts, obsoletes)
 */
function formatDepSection(
  tag: string,
  names: string[],
  flags: number[],
  versions: string[],
): string {
  if (names.length === 0) return '';
  const entries = names.map((name, i) =>
    formatRpmEntry(name, flags[i] || 0, versions[i] || '')
  ).join('\n');
  return `    <rpm:${tag}>\n${entries}\n    </rpm:${tag}>`;
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

  const requiresXml = formatDepSection('requires', headerData.requires, headerData.requireFlags, headerData.requireVersions);
  const providesXml = formatDepSection('provides', headerData.provides, headerData.provideFlags, headerData.provideVersions);
  const conflictsXml = formatDepSection('conflicts', headerData.conflicts, headerData.conflictFlags, headerData.conflictVersions);
  const obsoletesXml = formatDepSection('obsoletes', headerData.obsoletes, headerData.obsoleteFlags, headerData.obsoleteVersions);
  // File-dep paths. DNF reads these from <format> so it can resolve
  // `Requires: /usr/bin/foo` without parsing filelists.xml.
  const filesXml = headerData.primaryFiles.length > 0
    ? '\n' + headerData.primaryFiles.map(f => `      <file>${escapeXml(f)}</file>`).join('\n')
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
    <size package="${size}" installed="${headerData.installedSize}" archive="0"/>
    <location href="Packages/${escapeXml(filename)}"/>
    <format>
      <rpm:license>${escapeXml(headerData.license)}</rpm:license>
      <rpm:vendor>${escapeXml(headerData.vendor)}</rpm:vendor>
      <rpm:group>${escapeXml(headerData.group || 'Unspecified')}</rpm:group>
      <rpm:sourcerpm>${escapeXml(headerData.sourceRpm)}</rpm:sourcerpm>
${requiresXml}${filesXml}
${providesXml}
${conflictsXml}
${obsoletesXml}
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
 * Fetch and parse an RPM header, retrying with progressively larger range
 * requests when the header exceeds the fetched window (large file lists).
 * @returns the header, or null when it exceeds the largest range
 * @throws HeaderFetchError when a range request failed
 */
export async function fetchRpmMetadata(
  downloadUrl: string,
  githubToken?: string
): Promise<RpmHeaderData | null> {
  for (const size of RPM_RANGE_RETRY_LADDER) {
    try {
      return parseRpmBuffer(await fetchRange(downloadUrl, size, githubToken));
    } catch (err) {
      if (!(err instanceof RpmHeaderTruncatedError)) throw err;
    }
  }
  console.warn(`RPM header exceeds ${RPM_RANGE_RETRY_LADDER[RPM_RANGE_RETRY_LADDER.length - 1]} bytes; dropping ${downloadUrl}`);
  return null;
}

/**
 * Build an RpmPackageEntry from a GitHub asset and its parsed header.
 * Uses GitHub's digest field for the checksum when available.
 */
export function buildRpmPackageEntry(asset: GitHubAsset, headerData: RpmHeaderData): RpmPackageEntry {
  return {
    // Fall back to the filename's arch when the header has none
    headerData: headerData.arch ? headerData : { ...headerData, arch: extractRpmArchFromFilename(asset.name) },
    filename: asset.name,
    size: asset.size,
    checksum: asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : '',
    checksumType: 'sha256',
  };
}

/**
 * Filter GitHub assets to only .rpm files that have valid SHA256 checksums.
 * Assets without digests (older GitHub releases) are excluded because DNF
 * requires valid checksums for all packages.
 */
export function filterRpmAssets<T extends GitHubAsset>(assets: T[]): T[] {
  return assets.filter(asset =>
    asset.name.endsWith('.rpm') &&
    !asset.name.includes('.src.rpm') &&
    asset.digest?.startsWith('sha256:')
  );
}
