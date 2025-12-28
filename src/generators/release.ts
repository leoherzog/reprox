/**
 * Debian Release File Generator
 *
 * Generates the Release/InRelease metadata files that describe a repository.
 * These files contain checksums for all other metadata files in the repo.
 */

import { sha256, gzipCompress } from '../utils/crypto';

export interface ReleaseConfig {
  origin: string;
  label: string;
  suite: string;
  codename: string;
  architectures: string[];
  components: string[];
  description: string;
  date?: Date;
}

export interface ReleaseFileEntry {
  path: string;
  size: number;
  md5?: string;
  sha1?: string;
  sha256: string;
}

/**
 * Generate a Release file content
 */
export function generateReleaseFile(
  config: ReleaseConfig,
  files: ReleaseFileEntry[]
): string {
  const lines: string[] = [];
  const date = config.date || new Date();

  // Header fields
  lines.push(`Origin: ${config.origin}`);
  lines.push(`Label: ${config.label}`);
  lines.push(`Suite: ${config.suite}`);
  lines.push(`Codename: ${config.codename}`);
  lines.push(`Date: ${formatReleaseDate(date)}`);
  lines.push(`Architectures: ${config.architectures.join(' ')}`);
  lines.push(`Components: ${config.components.join(' ')}`);
  lines.push(`Description: ${config.description}`);
  // Enable Acquire-By-Hash for consistent fetching during updates
  lines.push(`Acquire-By-Hash: yes`);

  // MD5Sum section (optional, deprecated but some tools still want it)
  if (files.some(f => f.md5)) {
    lines.push('MD5Sum:');
    for (const file of files) {
      if (file.md5) {
        lines.push(` ${file.md5} ${file.size.toString().padStart(8)} ${file.path}`);
      }
    }
  }

  // SHA1 section (optional, deprecated)
  if (files.some(f => f.sha1)) {
    lines.push('SHA1:');
    for (const file of files) {
      if (file.sha1) {
        lines.push(` ${file.sha1} ${file.size.toString().padStart(8)} ${file.path}`);
      }
    }
  }

  // SHA256 section (required)
  lines.push('SHA256:');
  for (const file of files) {
    lines.push(` ${file.sha256} ${file.size.toString().padStart(8)} ${file.path}`);
  }

  return lines.join('\n') + '\n';
}

/**
 * Format date in Release file format (RFC 7231 HTTP-date)
 * Example: "Sat, 01 Jan 2024 00:00:00 GMT"
 */
function formatReleaseDate(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const dayName = days[date.getUTCDay()];
  const day = date.getUTCDate().toString().padStart(2, '0');
  const month = months[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  const hours = date.getUTCHours().toString().padStart(2, '0');
  const minutes = date.getUTCMinutes().toString().padStart(2, '0');
  const seconds = date.getUTCSeconds().toString().padStart(2, '0');

  return `${dayName}, ${day} ${month} ${year} ${hours}:${minutes}:${seconds} GMT`;
}


/**
 * Build Release file entries for a single architecture
 */
export async function buildReleaseEntriesForArch(
  packagesContent: string,
  component: string,
  architecture: string
): Promise<ReleaseFileEntry[]> {
  const entries: ReleaseFileEntry[] = [];

  // Uncompressed Packages file
  const packagesPath = `${component}/binary-${architecture}/Packages`;
  const packagesSize = new TextEncoder().encode(packagesContent).length;
  const packagesSha256 = await sha256(packagesContent);

  entries.push({
    path: packagesPath,
    size: packagesSize,
    sha256: packagesSha256,
  });

  // Gzipped Packages file
  const packagesGz = await gzipCompress(packagesContent);
  const packagesGzPath = `${component}/binary-${architecture}/Packages.gz`;
  const packagesGzSha256 = await sha256(packagesGz);

  entries.push({
    path: packagesGzPath,
    size: packagesGz.length,
    sha256: packagesGzSha256,
  });

  return entries;
}

/**
 * Build Release file entries for multiple architectures
 */
export async function buildReleaseEntries(
  packagesContentByArch: Map<string, string>,
  component: string
): Promise<ReleaseFileEntry[]> {
  const entries: ReleaseFileEntry[] = [];

  for (const [architecture, packagesContent] of packagesContentByArch) {
    const archEntries = await buildReleaseEntriesForArch(packagesContent, component, architecture);
    entries.push(...archEntries);
  }

  return entries;
}

/**
 * Generate default Release config for a GitHub repo
 */
export function defaultReleaseConfig(owner: string, repo: string): ReleaseConfig {
  return {
    origin: `${owner}/${repo}`,
    label: repo,
    suite: 'stable',
    codename: 'stable',
    architectures: ['amd64', 'arm64', 'i386', 'all'],
    components: ['main'],
    description: `APT repository for ${owner}/${repo} via Reprox`,
  };
}
