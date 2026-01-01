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

  // SHA256 section
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
  // Process all architectures in parallel
  const entryArrays = await Promise.all(
    Array.from(packagesContentByArch.entries()).map(
      ([architecture, packagesContent]) =>
        buildReleaseEntriesForArch(packagesContent, component, architecture)
    )
  );

  return entryArrays.flat();
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
