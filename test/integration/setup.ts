import { describe } from 'vitest';
import { env } from 'cloudflare:test';
import type { GitHubAsset } from '../../src/types';

// =============================================================================
// Centralized Test Repository Configuration
// =============================================================================

export interface TestRepo {
  owner: string;
  repo: string;
  expectedPackageName: string;
  hasDeb: boolean;
  hasRpm: boolean;
}

export const TEST_REPOS: TestRepo[] = [
  { owner: 'joshuar', repo: 'go-hass-agent', expectedPackageName: 'go-hass-agent', hasDeb: true, hasRpm: true },
  { owner: 'obsidianmd', repo: 'obsidian-releases', expectedPackageName: 'obsidian', hasDeb: true, hasRpm: false },
  { owner: 'localsend', repo: 'localsend', expectedPackageName: 'localsend', hasDeb: true, hasRpm: false },
  { owner: 'Heroic-Games-Launcher', repo: 'HeroicGamesLauncher', expectedPackageName: 'heroic', hasDeb: true, hasRpm: true },
  { owner: 'balena-io', repo: 'etcher', expectedPackageName: 'balena-etcher', hasDeb: true, hasRpm: false },
];

// =============================================================================
// Test Environment
// =============================================================================

// Access bindings from Workers environment (injected via vitest.config.ts)
interface TestEnv {
  GITHUB_TOKEN?: string;
  RUN_INTEGRATION_TESTS?: string;
}

const testEnv = env as TestEnv;

export const GITHUB_TOKEN = testEnv.GITHUB_TOKEN;

export const INTEGRATION_ENABLED =
  testEnv.RUN_INTEGRATION_TESTS === 'true' && !!GITHUB_TOKEN;

export const describeIntegration = INTEGRATION_ENABLED
  ? describe
  : describe.skip;

// =============================================================================
// GitHub API Helpers
// =============================================================================

const GITHUB_API_BASE = 'https://api.github.com';

function getHeaders(): HeadersInit {
  const headers: HeadersInit = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Reprox-Integration-Tests/1.0',
  };

  if (GITHUB_TOKEN) {
    headers['Authorization'] = `token ${GITHUB_TOKEN}`;
  }

  return headers;
}

/**
 * Fetch the latest release assets for a repository
 */
export async function getLatestReleaseAssets(
  owner: string,
  repo: string
): Promise<GitHubAsset[]> {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/releases/latest`;
  const response = await fetch(url, { headers: getHeaders() });

  if (!response.ok) {
    throw new Error(`Failed to fetch release for ${owner}/${repo}: ${response.status}`);
  }

  const release = await response.json();
  return release.assets as GitHubAsset[];
}

// =============================================================================
// Package Fetching Helpers
// =============================================================================

/**
 * Fetch the first N bytes of a package using Range request
 * Used for .deb files where we need to read the AR/TAR headers
 */
export async function fetchPackageHeader(
  url: string,
  bytes = 262144 // 256KB - enough for control data
): Promise<ArrayBuffer> {
  const headers: HeadersInit = {
    'Range': `bytes=0-${bytes - 1}`,
    'User-Agent': 'Reprox-Integration-Tests/1.0',
  };

  if (GITHUB_TOKEN) {
    headers['Authorization'] = `token ${GITHUB_TOKEN}`;
  }

  const response = await fetch(url, { headers });

  if (!response.ok && response.status !== 206) {
    throw new Error(`Failed to fetch package header: ${response.status}`);
  }

  return response.arrayBuffer();
}

/**
 * Find a .deb asset matching the given architecture pattern
 * Handles various naming conventions: amd64, x86_64, x86-64, etc.
 */
export function findDebAsset(
  assets: GitHubAsset[],
  archPattern: string = 'amd64'
): GitHubAsset | undefined {
  // Map of equivalent patterns for each architecture
  const archPatterns: Record<string, string[]> = {
    'amd64': ['amd64', 'x86_64', 'x86-64', 'x64'],
    'arm64': ['arm64', 'aarch64', 'arm-64'],
  };

  const patterns = archPatterns[archPattern] || [archPattern];

  return assets.find(
    a => a.name.endsWith('.deb') && patterns.some(p => a.name.includes(p))
  );
}

/**
 * Find a .rpm asset matching the given architecture pattern
 */
export function findRpmAsset(
  assets: GitHubAsset[],
  archPattern: string = 'x86_64'
): GitHubAsset | undefined {
  return assets.find(
    a => a.name.endsWith('.rpm') &&
      !a.name.includes('.src.rpm') &&
      a.name.includes(archPattern)
  );
}
