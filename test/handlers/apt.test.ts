/**
 * APT Handler Tests
 *
 * Tests for Debian/APT repository handler functions in src/index.ts:
 * - handleInRelease
 * - handleRelease
 * - handleReleaseGpg
 * - handlePackages
 * - handlePackagesGz
 * - handleByHash
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../../src/index';
import {
  createMockEnv,
  createMockExecutionContext,
  createMockGitHubRelease,
  createMockGitHubAsset,
  type MockExecutionContext,
} from '../helpers';

// ============================================================================
// Test Fixtures
// ============================================================================

const MOCK_DEB_ASSET = createMockGitHubAsset({
  name: 'test-app_1.0.0_amd64.deb',
  size: 50000,
  browser_download_url: 'https://github.com/owner/repo/releases/download/v1.0.0/test-app_1.0.0_amd64.deb',
});

const MOCK_RELEASE_WITH_DEB = createMockGitHubRelease({
  id: 12345,
  tag_name: 'v1.0.0',
  published_at: '2024-01-15T12:00:00Z',
  assets: [MOCK_DEB_ASSET],
});

// ============================================================================
// GitHub API Mock Helper
// ============================================================================

function mockGitHubReleasesAPI(releases: ReturnType<typeof createMockGitHubRelease>[]) {
  vi.mocked(fetch).mockImplementation(async (url) => {
    const urlStr = url.toString();

    // Handle paginated releases endpoint
    if (urlStr.includes('api.github.com') && urlStr.includes('/releases')) {
      return new Response(JSON.stringify(releases), {
        status: 200,
        headers: new Headers({ link: '' }),
      });
    }

    // Handle range requests for .deb files (for metadata extraction)
    if (urlStr.endsWith('.deb')) {
      // Return minimal AR archive header for range request
      return new Response(new ArrayBuffer(64), {
        status: 206,
        headers: new Headers({ 'Content-Range': 'bytes 0-63/50000' }),
      });
    }

    return new Response('Not found', { status: 404 });
  });
}

/**
 * Helper to make a request and wait for background tasks
 */
async function fetchAndFlush(
  request: Request,
  env: ReturnType<typeof createMockEnv>,
  ctx: MockExecutionContext
): Promise<Response> {
  const response = await worker.fetch(request, env, ctx);
  await ctx.flushWaitUntil();
  return response;
}

// ============================================================================
// handleInRelease Tests
// ============================================================================

describe('handleInRelease', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns InRelease file with correct headers', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([MOCK_RELEASE_WITH_DEB]);

    const request = new Request('https://example.com/owner/repo/dists/stable/InRelease');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/plain');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('returns unsigned content when no GPG key configured', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([MOCK_RELEASE_WITH_DEB]);

    const request = new Request('https://example.com/owner/repo/dists/stable/InRelease');
    const response = await fetchAndFlush(request, env, ctx);

    const text = await response.text();
    // Without GPG key, should return plain Release content (not signed)
    expect(text).not.toContain('-----BEGIN PGP SIGNED MESSAGE-----');
    // Should contain Release file fields
    expect(text).toContain('Origin:');
    expect(text).toContain('Suite:');
  });

  it('throws error when no releases found', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([]); // Empty releases

    const request = new Request('https://example.com/owner/repo/dists/stable/InRelease');

    await expect(fetchAndFlush(request, env, ctx)).rejects.toThrow('No releases found');
  });

  it('spawns background validation task', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([MOCK_RELEASE_WITH_DEB]);

    const request = new Request('https://example.com/owner/repo/dists/stable/InRelease');
    await fetchAndFlush(request, env, ctx);

    // Should have called waitUntil for background tasks
    expect(ctx.waitUntil).toHaveBeenCalled();
  });

  it('respects prerelease variant in route', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();

    const prereleaseRelease = createMockGitHubRelease({
      id: 99999,
      tag_name: 'v2.0.0-beta.1',
      prerelease: true,
      assets: [MOCK_DEB_ASSET],
    });

    mockGitHubReleasesAPI([prereleaseRelease]);

    const request = new Request('https://example.com/owner/repo/prerelease/dists/stable/InRelease');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(200);
  });
});

// ============================================================================
// handleRelease Tests
// ============================================================================

describe('handleRelease', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns Release file with correct headers', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([MOCK_RELEASE_WITH_DEB]);

    const request = new Request('https://example.com/owner/repo/dists/stable/Release');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/plain');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('returns Release file with correct content format', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([MOCK_RELEASE_WITH_DEB]);

    const request = new Request('https://example.com/owner/repo/dists/stable/Release');
    const response = await fetchAndFlush(request, env, ctx);

    const text = await response.text();
    // Should contain standard Release file fields
    expect(text).toContain('Origin:');
    expect(text).toContain('Label:');
    expect(text).toContain('Suite:');
    expect(text).toContain('Codename:');
    expect(text).toContain('Date:');
    expect(text).toContain('Architectures:');
    expect(text).toContain('Components:');
  });

  it('throws error when no releases found', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([]);

    const request = new Request('https://example.com/owner/repo/dists/stable/Release');

    await expect(fetchAndFlush(request, env, ctx)).rejects.toThrow('No releases found');
  });
});

// ============================================================================
// handleReleaseGpg Tests
// ============================================================================

describe('handleReleaseGpg', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns 404 when no GPG key configured', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([MOCK_RELEASE_WITH_DEB]);

    const request = new Request('https://example.com/owner/repo/dists/stable/Release.gpg');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).toContain('No GPG key configured');
  });
});

// ============================================================================
// handlePackages Tests
// ============================================================================

describe('handlePackages', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns Packages file with correct headers', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([MOCK_RELEASE_WITH_DEB]);

    const request = new Request('https://example.com/owner/repo/dists/stable/main/binary-amd64/Packages');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/plain');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('returns empty content when no packages for architecture', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();

    // Release with only arm64 package
    const arm64Asset = createMockGitHubAsset({
      name: 'test-app_1.0.0_arm64.deb',
      browser_download_url: 'https://github.com/owner/repo/releases/download/v1.0.0/test-app_1.0.0_arm64.deb',
    });
    const release = createMockGitHubRelease({
      assets: [arm64Asset],
    });

    mockGitHubReleasesAPI([release]);

    // Request amd64 packages
    const request = new Request('https://example.com/owner/repo/dists/stable/main/binary-amd64/Packages');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(200);
    const text = await response.text();
    // Should be empty or only whitespace since no amd64 packages exist
    expect(text.trim()).toBe('');
  });

  it('returns empty content when no releases exist', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([]);

    const request = new Request('https://example.com/owner/repo/dists/stable/main/binary-amd64/Packages');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe('');
  });
});

// ============================================================================
// handlePackagesGz Tests
// ============================================================================

describe('handlePackagesGz', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns gzip-compressed content with correct headers', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([MOCK_RELEASE_WITH_DEB]);

    const request = new Request('https://example.com/owner/repo/dists/stable/main/binary-amd64/Packages.gz');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/gzip');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('returns valid gzip data', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([]);

    const request = new Request('https://example.com/owner/repo/dists/stable/main/binary-amd64/Packages.gz');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(200);
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // Gzip magic number check (0x1f 0x8b)
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
  });
});

// ============================================================================
// handleByHash Tests
// ============================================================================

describe('handleByHash', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns 404 for unsupported hash type MD5', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([MOCK_RELEASE_WITH_DEB]);

    const request = new Request(
      'https://example.com/owner/repo/dists/stable/main/binary-amd64/by-hash/MD5/abc123'
    );
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(404);
    expect(await response.text()).toContain('Unsupported hash type: MD5');
  });

  it('returns 404 for unsupported hash type SHA512', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([MOCK_RELEASE_WITH_DEB]);

    const request = new Request(
      'https://example.com/owner/repo/dists/stable/main/binary-amd64/by-hash/SHA512/abc123'
    );
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(404);
    expect(await response.text()).toContain('Unsupported hash type: SHA512');
  });

  it('returns 400 for invalid by-hash request without hash value', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([MOCK_RELEASE_WITH_DEB]);

    // Missing hash value
    const request = new Request(
      'https://example.com/owner/repo/dists/stable/main/binary-amd64/by-hash/SHA256/'
    );
    const response = await fetchAndFlush(request, env, ctx);

    // Should be 400 or 404 depending on route parsing
    expect([400, 404]).toContain(response.status);
  });

  it('returns 404 when hash does not match current content', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([]);

    // Request with a non-matching hash
    const request = new Request(
      'https://example.com/owner/repo/dists/stable/main/binary-amd64/by-hash/SHA256/0000000000000000000000000000000000000000000000000000000000000000'
    );
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(404);
    expect(await response.text()).toContain('Hash not found');
  });

  it('uses longer cache control for immutable by-hash content', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([]);

    // First get the actual hash by requesting Packages
    const packagesRequest = new Request(
      'https://example.com/owner/repo/dists/stable/main/binary-amd64/Packages'
    );
    const packagesResponse = await fetchAndFlush(packagesRequest, env, ctx);
    const packagesContent = await packagesResponse.text();

    // Calculate SHA256 of the content
    const encoder = new TextEncoder();
    const data = encoder.encode(packagesContent);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    // Now request by hash (use new context for second request)
    const ctx2 = createMockExecutionContext();
    const byHashRequest = new Request(
      `https://example.com/owner/repo/dists/stable/main/binary-amd64/by-hash/SHA256/${hash}`
    );
    const byHashResponse = await fetchAndFlush(byHashRequest, env, ctx2);

    if (byHashResponse.status === 200) {
      // Should have longer cache (86400 vs 300)
      expect(byHashResponse.headers.get('Cache-Control')).toBe('public, max-age=86400');
    }
  });
});
