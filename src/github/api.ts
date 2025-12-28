import type { GitHubRelease, GitHubAsset } from '../types';
import { extractArchFromFilename } from '../utils/architectures';

// Re-export for backward compatibility
export { extractArchFromFilename };

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
      'User-Agent': 'Reprox/1.0',
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
      if (response.status === 403 || response.status === 429) {
        throw new Error(`GitHub API rate limit exceeded`);
      }
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }
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
