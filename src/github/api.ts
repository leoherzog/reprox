import type { GitHubRelease, GitHubAsset } from '../types';
import { extractArchFromFilename } from '../utils/architectures';

// Re-export for backward compatibility
export { extractArchFromFilename };

const GITHUB_API_BASE = 'https://api.github.com';

// Maximum pages to fetch to prevent infinite loops (50 pages * 100 = 5000 releases max)
const MAX_PAGES = 50;

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
   * Get all releases for a repository with pagination
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param includePrerelease - Whether to include prerelease versions (default: false)
   * @returns Array of releases, sorted by published date (newest first)
   */
  async getAllReleases(
    owner: string,
    repo: string,
    includePrerelease: boolean = false
  ): Promise<GitHubRelease[]> {
    const releases: GitHubRelease[] = [];
    let page = 1;

    while (page <= MAX_PAGES) {
      const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/releases?per_page=100&page=${page}`;
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

      const pageReleases: GitHubRelease[] = await response.json();
      if (pageReleases.length === 0) break;

      // Filter prereleases unless includePrerelease is true
      const filtered = includePrerelease
        ? pageReleases
        : pageReleases.filter(r => !r.prerelease);

      releases.push(...filtered);

      // If we got fewer than 100, we've reached the last page
      if (pageReleases.length < 100) break;
      page++;
    }

    return releases;
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
