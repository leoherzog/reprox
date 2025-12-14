import type { GitHubRelease, GitHubAsset } from '../types';

const GITHUB_API_BASE = 'https://api.github.com';

/**
 * GitHub API client for fetching release information
 */
export class GitHubClient {
  private token?: string;

  constructor(token?: string) {
    this.token = token;
  }

  private getHeaders(): HeadersInit {
    const headers: HeadersInit = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Repoxy/1.0',
    };

    if (this.token) {
      headers['Authorization'] = `token ${this.token}`;
    }

    return headers;
  }

  /**
   * Get the latest release for a repository
   */
  async getLatestRelease(owner: string, repo: string): Promise<GitHubRelease> {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/releases/latest`;
    const response = await fetch(url, { headers: this.getHeaders() });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Repository ${owner}/${repo} not found or has no releases`);
      }
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }
}

/**
 * Determine architecture from asset filename.
 * Used to categorize .deb files by target architecture.
 */
export function extractArchFromFilename(filename: string): string {
  const patterns: [RegExp, string][] = [
    [/[_.-](amd64|x86_64|x64)[_.-]/i, 'amd64'],
    [/[_.-](arm64|aarch64)[_.-]/i, 'arm64'],
    [/[_.-](i386|i686|x86)[_.-](?!64)/i, 'i386'],
    [/[_.-](armhf|armv7)[_.-]/i, 'armhf'],
    [/[_.-]all[_.-]/i, 'all'],
  ];

  for (const [pattern, arch] of patterns) {
    if (pattern.test(filename)) {
      return arch;
    }
  }

  // Default to amd64 if no pattern matches
  return 'amd64';
}

/**
 * Get unique architectures from a list of assets
 */
export function getArchitecturesFromAssets<T extends { name: string }>(assets: T[]): string[] {
  const archs = new Set<string>();

  for (const asset of assets) {
    if (asset.name.endsWith('.deb')) {
      archs.add(extractArchFromFilename(asset.name));
    }
  }

  // Always include 'all' for arch-independent packages
  archs.add('all');

  return Array.from(archs).sort();
}
