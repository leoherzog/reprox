import type { GitHubRelease, GitHubAsset } from '../types';
import { extractArchFromFilename } from '../utils/architectures';

const GITHUB_API_BASE = 'https://api.github.com';

// Maximum pages to fetch to prevent infinite loops (50 pages * 100 = 5000 releases max)
const MAX_PAGES = 50;

/**
 * Build GitHub request headers with the standard User-Agent and an optional
 * `Authorization: token <...>`. `accept` selects between JSON API calls
 * (`application/vnd.github.v3+json`) and binary asset downloads
 * (`application/octet-stream`).
 */
export function githubHeaders(
  token?: string,
  accept: 'json' | 'octet-stream' = 'json'
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept === 'json'
      ? 'application/vnd.github.v3+json'
      : 'application/octet-stream',
    'User-Agent': 'Reprox/1.0',
  };
  if (token) headers['Authorization'] = `token ${token}`;
  return headers;
}

/**
 * GitHub API client for fetching release information
 */
export class GitHubClient {
  private token?: string;

  constructor(token?: string) {
    this.token = token;
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
      const response = await fetch(url, { headers: githubHeaders(this.token) });

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

      // Filter:
      // 1. Draft releases (published_at is null) - always excluded.
      //    A release demoted to draft mid-pagination can slip through here,
      //    so downstream code must not rely on non-null published_at.
      // 2. Prereleases (unless includePrerelease is true)
      const filtered = pageReleases.filter(r => {
        if (r.published_at === null) return false;
        return includePrerelease || !r.prerelease;
      });

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

  // Note: 'all' architecture is added organically when arch-independent
  // packages are found (extractArchFromFilename returns 'all' for them)

  return Array.from(archs).sort();
}
