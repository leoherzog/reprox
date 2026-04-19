/**
 * RPM Handler Tests
 *
 * Tests for RPM repository handler functions in src/index.ts:
 * - handleRepomd
 * - handleRepomdAsc
 * - handleRpmXml (primary, filelists, other)
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

const MOCK_RPM_ASSET = createMockGitHubAsset({
  name: 'test-app-1.0.0-1.x86_64.rpm',
  size: 75000,
  browser_download_url: 'https://github.com/owner/repo/releases/download/v1.0.0/test-app-1.0.0-1.x86_64.rpm',
});

const MOCK_RELEASE_WITH_RPM = createMockGitHubRelease({
  id: 12345,
  tag_name: 'v1.0.0',
  published_at: '2024-01-15T12:00:00Z',
  assets: [MOCK_RPM_ASSET],
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

    // Handle range requests for .rpm files (for metadata extraction)
    if (urlStr.endsWith('.rpm')) {
      // Return minimal RPM header for range request
      return new Response(new ArrayBuffer(256), {
        status: 206,
        headers: new Headers({ 'Content-Range': 'bytes 0-255/75000' }),
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
// handleRepomd Tests
// ============================================================================

describe('handleRepomd', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns repomd.xml with correct headers', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([MOCK_RELEASE_WITH_RPM]);

    const request = new Request('https://example.com/owner/repo/repodata/repomd.xml');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/xml');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('returns valid XML structure', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([MOCK_RELEASE_WITH_RPM]);

    const request = new Request('https://example.com/owner/repo/repodata/repomd.xml');
    const response = await fetchAndFlush(request, env, ctx);

    const text = await response.text();
    // Should be valid XML with repomd structure
    expect(text).toContain('<?xml');
    expect(text).toContain('<repomd');
    expect(text).toContain('<data type="primary"');
    expect(text).toContain('<data type="filelists"');
    expect(text).toContain('<data type="other"');
  });

  it('handles empty releases gracefully', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([]);

    const request = new Request('https://example.com/owner/repo/repodata/repomd.xml');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(200);
    const text = await response.text();
    // Should still return valid XML even with no packages
    expect(text).toContain('<repomd');
  });

  it('spawns background validation task', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([MOCK_RELEASE_WITH_RPM]);

    const request = new Request('https://example.com/owner/repo/repodata/repomd.xml');
    await fetchAndFlush(request, env, ctx);

    expect(ctx.waitUntil).toHaveBeenCalled();
  });

  it('respects prerelease variant', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();

    const prereleaseRelease = createMockGitHubRelease({
      id: 99999,
      tag_name: 'v2.0.0-rc.1',
      prerelease: true,
      assets: [MOCK_RPM_ASSET],
    });

    mockGitHubReleasesAPI([prereleaseRelease]);

    const request = new Request('https://example.com/owner/repo/prerelease/repodata/repomd.xml');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(200);
  });
});

// ============================================================================
// handleRepomdAsc Tests
// ============================================================================

describe('handleRepomdAsc', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns 404 when no GPG key configured', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([MOCK_RELEASE_WITH_RPM]);

    const request = new Request('https://example.com/owner/repo/repodata/repomd.xml.asc');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).toContain('GPG signing not configured');
  });
});

// ============================================================================
// handleRpmXml Tests - primary.xml
// ============================================================================

describe('handleRpmXml - primary', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns primary.xml with correct headers', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([MOCK_RELEASE_WITH_RPM]);

    const request = new Request('https://example.com/owner/repo/repodata/primary.xml');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/xml');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('returns primary.xml.gz with correct headers', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([MOCK_RELEASE_WITH_RPM]);

    const request = new Request('https://example.com/owner/repo/repodata/primary.xml.gz');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/gzip');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('returns valid gzip data for primary.xml.gz', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([]);

    const request = new Request('https://example.com/owner/repo/repodata/primary.xml.gz');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(200);
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // Gzip magic number check (0x1f 0x8b)
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
  });

  it('returns valid XML structure for primary.xml', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([]);

    const request = new Request('https://example.com/owner/repo/repodata/primary.xml');
    const response = await fetchAndFlush(request, env, ctx);

    const text = await response.text();
    expect(text).toContain('<?xml');
    expect(text).toContain('<metadata');
    expect(text).toContain('packages=');
  });
});

// ============================================================================
// handleRpmXml Tests - filelists.xml
// ============================================================================

describe('handleRpmXml - filelists', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns filelists.xml with correct headers', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([]);

    const request = new Request('https://example.com/owner/repo/repodata/filelists.xml');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/xml');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('returns filelists.xml.gz with correct headers', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([]);

    const request = new Request('https://example.com/owner/repo/repodata/filelists.xml.gz');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/gzip');
  });

  it('returns valid XML structure for filelists.xml', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([]);

    const request = new Request('https://example.com/owner/repo/repodata/filelists.xml');
    const response = await fetchAndFlush(request, env, ctx);

    const text = await response.text();
    expect(text).toContain('<?xml');
    expect(text).toContain('<filelists');
    expect(text).toContain('packages=');
  });
});

// ============================================================================
// handleRpmXml Tests - other.xml
// ============================================================================

describe('handleRpmXml - other', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns other.xml with correct headers', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([]);

    const request = new Request('https://example.com/owner/repo/repodata/other.xml');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/xml');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('returns other.xml.gz with correct headers', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([]);

    const request = new Request('https://example.com/owner/repo/repodata/other.xml.gz');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/gzip');
  });

  it('returns valid XML structure for other.xml', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([]);

    const request = new Request('https://example.com/owner/repo/repodata/other.xml');
    const response = await fetchAndFlush(request, env, ctx);

    const text = await response.text();
    expect(text).toContain('<?xml');
    expect(text).toContain('<otherdata');
    expect(text).toContain('packages=');
  });
});

// ============================================================================
// RPM Binary Redirect Tests
// ============================================================================

describe('handleBinaryRedirect - RPM', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Mock helper that simulates public repo (HEAD returns 200)
   */
  function mockPublicRepo(releases: ReturnType<typeof createMockGitHubRelease>[]) {
    vi.mocked(fetch).mockImplementation(async (url, options) => {
      const urlStr = url.toString();

      if (urlStr.includes('api.github.com') && urlStr.includes('/releases')) {
        return new Response(JSON.stringify(releases), {
          status: 200,
          headers: new Headers({ link: '' }),
        });
      }

      // HEAD request to check public accessibility - return 200 for public
      if (options?.method === 'HEAD') {
        return new Response(null, { status: 200 });
      }

      // Handle range requests for .rpm files (for metadata extraction)
      if (urlStr.endsWith('.rpm')) {
        return new Response(new ArrayBuffer(256), {
          status: 206,
          headers: new Headers({ 'Content-Range': 'bytes 0-255/75000' }),
        });
      }

      return new Response('Not found', { status: 404 });
    });
  }

  /**
   * Mock helper that simulates private repo (HEAD returns 401, GET with auth works)
   */
  function mockPrivateRepo(releases: ReturnType<typeof createMockGitHubRelease>[], expectedUrl: string) {
    vi.mocked(fetch).mockImplementation(async (url, options) => {
      const urlStr = url.toString();

      if (urlStr.includes('api.github.com') && urlStr.includes('/releases')) {
        return new Response(JSON.stringify(releases), {
          status: 200,
          headers: new Headers({ link: '' }),
        });
      }

      // HEAD request to check public accessibility - return 401 for private
      if (options?.method === 'HEAD') {
        return new Response(null, { status: 401 });
      }

      // GET with auth - return content
      if (urlStr === expectedUrl) {
        const headers = options?.headers as Record<string, string> | undefined;
        if (headers?.Authorization) {
          return new Response('fake-rpm-content', {
            status: 200,
            headers: { 'Content-Type': 'application/octet-stream' },
          });
        }
        return new Response('Unauthorized', { status: 401 });
      }

      return new Response('Not found', { status: 404 });
    });
  }

  it('returns 302 redirect for public repo (auto-detected)', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' }); // Token set but repo is public
    const ctx = createMockExecutionContext();
    mockPublicRepo([MOCK_RELEASE_WITH_RPM]);

    const request = new Request('https://example.com/owner/repo/Packages/test-app-1.0.0-1.x86_64.rpm');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(MOCK_RPM_ASSET.browser_download_url);
  });

  it('proxies download for private repo (auto-detected)', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockPrivateRepo([MOCK_RELEASE_WITH_RPM], MOCK_RPM_ASSET.browser_download_url);

    const request = new Request('https://example.com/owner/repo/Packages/test-app-1.0.0-1.x86_64.rpm');
    const response = await fetchAndFlush(request, env, ctx);

    // Should proxy (200) not redirect (302) for private repos
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
  });

  it('returns 404 for non-existent RPM asset', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: '' });
    const ctx = createMockExecutionContext();
    mockPublicRepo([MOCK_RELEASE_WITH_RPM]);

    const request = new Request('https://example.com/owner/repo/Packages/nonexistent-1.0.0-1.x86_64.rpm');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).toContain('not found');
  });

  it('returns 404 when no releases exist', async () => {
    // Use a unique owner/repo so the Workers Cache from previous tests in
    // this file (which vitest-pool-workers 0.14 no longer isolates per-test)
    // cannot serve a stale cached asset URL and redirect with 302.
    const env = createMockEnv({ GITHUB_TOKEN: '' });
    const ctx = createMockExecutionContext();
    mockPublicRepo([]);

    const request = new Request('https://example.com/empty-rpm-owner/empty-rpm-repo/Packages/test-app-1.0.0-1.x86_64.rpm');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(404);
  });
});
