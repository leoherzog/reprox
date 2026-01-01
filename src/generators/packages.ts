import type { DebianControlData, PackageEntry, AssetLike } from '../types';
import { parseDebBufferAsync } from '../parsers/deb';
import { extractArchFromFilename } from '../github/api';

/**
 * Range request size for .deb header parsing
 * 64KB is usually enough to contain the control.tar.gz
 */
const RANGE_SIZE = 65536;

/**
 * Generate a Debian Packages file entry for a single package
 */
export function generatePackageEntry(entry: PackageEntry): string {
  const lines: string[] = [];
  const { controlData, filename, size, sha256, md5sum } = entry;

  // Required fields
  lines.push(`Package: ${controlData.package}`);
  lines.push(`Version: ${controlData.version}`);
  lines.push(`Architecture: ${controlData.architecture}`);

  // Optional but commonly expected fields
  if (controlData.maintainer) {
    lines.push(`Maintainer: ${controlData.maintainer}`);
  }

  if (controlData.installedSize > 0) {
    lines.push(`Installed-Size: ${controlData.installedSize}`);
  }

  if (controlData.depends) {
    lines.push(`Depends: ${controlData.depends}`);
  }

  if (controlData.recommends) {
    lines.push(`Recommends: ${controlData.recommends}`);
  }

  if (controlData.suggests) {
    lines.push(`Suggests: ${controlData.suggests}`);
  }

  if (controlData.conflicts) {
    lines.push(`Conflicts: ${controlData.conflicts}`);
  }

  if (controlData.replaces) {
    lines.push(`Replaces: ${controlData.replaces}`);
  }

  if (controlData.provides) {
    lines.push(`Provides: ${controlData.provides}`);
  }

  if (controlData.section) {
    lines.push(`Section: ${controlData.section}`);
  }

  if (controlData.priority) {
    lines.push(`Priority: ${controlData.priority}`);
  }

  if (controlData.homepage) {
    lines.push(`Homepage: ${controlData.homepage}`);
  }

  // File information
  lines.push(`Filename: ${filename}`);
  lines.push(`Size: ${size}`);

  if (sha256) {
    lines.push(`SHA256: ${sha256}`);
  }

  if (md5sum) {
    lines.push(`MD5sum: ${md5sum}`);
  }

  // Description (can be multi-line)
  if (controlData.description) {
    const descLines = controlData.description.split('\n');
    lines.push(`Description: ${descLines[0]}`);
    for (let i = 1; i < descLines.length; i++) {
      // Continuation lines start with a space
      // Empty lines become " ."
      const line = descLines[i].trim();
      lines.push(line ? ` ${line}` : ' .');
    }
  }

  return lines.join('\n');
}

/**
 * Generate a complete Packages file from multiple entries
 */
export function generatePackagesFile(entries: PackageEntry[]): string {
  return entries.map(generatePackageEntry).join('\n\n') + '\n';
}

/**
 * Fetch and parse a .deb file to extract metadata
 */
export async function fetchDebMetadata(
  downloadUrl: string,
  githubToken?: string
): Promise<DebianControlData> {
  // Build headers for range request
  const headers: HeadersInit = {
    Range: `bytes=0-${RANGE_SIZE - 1}`,
    Accept: 'application/octet-stream',
    'User-Agent': 'Reprox/1.0',
  };

  if (githubToken) {
    headers['Authorization'] = `token ${githubToken}`;
  }

  // GitHub download URLs need to follow redirects
  // The browser_download_url redirects to the actual file
  const response = await fetch(downloadUrl, {
    headers,
    redirect: 'follow',
  });

  if (!response.ok && response.status !== 206) {
    throw new Error(`Failed to fetch .deb: ${response.status} ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  return parseDebBufferAsync(buffer);
}

/**
 * Build a PackageEntry from a GitHub asset
 */
export async function buildPackageEntry(
  asset: AssetLike,
  owner: string,
  repo: string,
  tag: string,
  githubToken?: string
): Promise<PackageEntry> {
  // Fetch metadata from .deb header
  const controlData = await fetchDebMetadata(asset.browser_download_url, githubToken);

  // Override architecture from filename if control says "all" but filename is specific
  if (controlData.architecture === 'all') {
    const filenameArch = extractArchFromFilename(asset.name);
    if (filenameArch !== 'all') {
      controlData.architecture = filenameArch;
    }
  }

  // The filename uses pool-style path structure: pool/{component}/{prefix}/{package}/{file}
  // When APT requests this path, the router extracts just the filename (last segment)
  // to match against GitHub release assets. See handleBinaryRedirect() in index.ts.
  const filename = `pool/main/${controlData.package[0]}/${controlData.package}/${asset.name}`;

  // Extract SHA256 from GitHub's digest field (format: "sha256:...")
  let sha256 = '';
  if (asset.digest?.startsWith('sha256:')) {
    sha256 = asset.digest.slice(7);
  }

  return {
    controlData,
    filename,
    size: asset.size,
    sha256,
    md5sum: '',
  };
}

/**
 * Filter assets to only .deb files that have valid SHA256 checksums.
 * Assets without digests (older GitHub releases) are excluded because APT
 * validates checksums against the Packages file.
 */
export function filterDebAssets<T extends AssetLike>(assets: T[]): T[] {
  return assets.filter(asset =>
    asset.name.endsWith('.deb') &&
    asset.digest?.startsWith('sha256:')
  );
}

/**
 * Filter assets by architecture.
 * When arch is 'all', returns only architecture-independent packages.
 * When arch is specific (e.g., 'amd64'), returns packages for that arch plus 'all' packages.
 */
export function filterByArchitecture<T extends AssetLike>(assets: T[], arch: string): T[] {
  return assets.filter(asset => {
    const assetArch = extractArchFromFilename(asset.name);
    if (arch === 'all') {
      // Only return packages marked as architecture-independent
      return assetArch === 'all';
    }
    // Return packages matching the specific arch, plus arch-independent packages
    return assetArch === arch || assetArch === 'all';
  });
}
