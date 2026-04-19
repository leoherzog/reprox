/**
 * Common Handler Tests
 *
 * Tests for shared handler functions in src/index.ts:
 * - handleFavicon
 * - handleBinaryRedirect (DEB)
 * - Extended handleReadme tests (fingerprint)
 * - Extended handlePublicKey tests (extraction)
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

    if (urlStr.includes('api.github.com') && urlStr.includes('/releases')) {
      return new Response(JSON.stringify(releases), {
        status: 200,
        headers: new Headers({ link: '' }),
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
// handleFavicon Tests
// ============================================================================

describe('handleFavicon', () => {
  it('returns SVG favicon with correct Content-Type', async () => {
    const env = createMockEnv();
    const ctx = createMockExecutionContext();

    const request = new Request('https://example.com/favicon.ico');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/svg+xml');
  });

  it('returns SVG favicon for /favicon.svg path', async () => {
    const env = createMockEnv();
    const ctx = createMockExecutionContext();

    const request = new Request('https://example.com/favicon.svg');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/svg+xml');
  });

  it('includes 24-hour cache control', async () => {
    const env = createMockEnv();
    const ctx = createMockExecutionContext();

    const request = new Request('https://example.com/favicon.ico');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400');
  });

  it('returns valid SVG with dark mode support', async () => {
    const env = createMockEnv();
    const ctx = createMockExecutionContext();

    const request = new Request('https://example.com/favicon.ico');
    const response = await fetchAndFlush(request, env, ctx);

    const text = await response.text();
    // Check it's valid SVG
    expect(text).toContain('<svg');
    expect(text).toContain('xmlns="http://www.w3.org/2000/svg"');
    // Check for dark mode styles
    expect(text).toContain('@media (prefers-color-scheme: dark)');
    // Check for path element
    expect(text).toContain('<path');
  });

  it('includes both light and dark mode colors', async () => {
    const env = createMockEnv();
    const ctx = createMockExecutionContext();

    const request = new Request('https://example.com/favicon.ico');
    const response = await fetchAndFlush(request, env, ctx);

    const text = await response.text();
    // Light mode color
    expect(text).toContain('#1f2328');
    // Dark mode color
    expect(text).toContain('#f0f6fc');
  });
});

// ============================================================================
// handleBinaryRedirect Tests - DEB
// ============================================================================

describe('handleBinaryRedirect - DEB', () => {
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
          return new Response('fake-deb-content', {
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
    mockPublicRepo([MOCK_RELEASE_WITH_DEB]);

    const request = new Request('https://example.com/owner/repo/pool/main/t/test-app/test-app_1.0.0_amd64.deb');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(MOCK_DEB_ASSET.browser_download_url);
  });

  it('proxies download for private repo (auto-detected)', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockPrivateRepo([MOCK_RELEASE_WITH_DEB], MOCK_DEB_ASSET.browser_download_url);

    const request = new Request('https://example.com/owner/repo/pool/main/t/test-app/test-app_1.0.0_amd64.deb');
    const response = await fetchAndFlush(request, env, ctx);

    // Should proxy (200) not redirect (302) for private repos
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
  });

  it('returns 401 for private repo without token', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: '' }); // No token
    const ctx = createMockExecutionContext();

    // Mock private repo behavior
    vi.mocked(fetch).mockImplementation(async (url, options) => {
      const urlStr = url.toString();

      if (urlStr.includes('api.github.com') && urlStr.includes('/releases')) {
        return new Response(JSON.stringify([MOCK_RELEASE_WITH_DEB]), {
          status: 200,
          headers: new Headers({ link: '' }),
        });
      }

      // HEAD request returns 401 (private)
      if (options?.method === 'HEAD') {
        return new Response(null, { status: 401 });
      }

      return new Response('Not found', { status: 404 });
    });

    const request = new Request('https://example.com/owner/repo/pool/main/t/test-app/test-app_1.0.0_amd64.deb');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(401);
  });

  it('returns 404 for non-existent DEB asset', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: '' });
    const ctx = createMockExecutionContext();
    mockPublicRepo([MOCK_RELEASE_WITH_DEB]);

    const request = new Request('https://example.com/owner/repo/pool/main/n/nonexistent/nonexistent_1.0.0_amd64.deb');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).toContain('not found');
  });

  it('returns 404 when no releases exist', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: '' });
    const ctx = createMockExecutionContext();
    mockPublicRepo([]);

    const request = new Request('https://example.com/owner/repo/pool/main/t/test-app/test-app_1.0.0_amd64.deb');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(404);
  });

  it('finds asset across multiple releases', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: '' });
    const ctx = createMockExecutionContext();

    const oldAsset = createMockGitHubAsset({
      name: 'old-app_0.9.0_amd64.deb',
      browser_download_url: 'https://github.com/owner/repo/releases/download/v0.9.0/old-app_0.9.0_amd64.deb',
    });

    const releases = [
      MOCK_RELEASE_WITH_DEB,
      createMockGitHubRelease({
        id: 11111,
        tag_name: 'v0.9.0',
        assets: [oldAsset],
      }),
    ];

    mockPublicRepo(releases);

    // Request the asset from the older release
    const request = new Request('https://example.com/owner/repo/pool/main/o/old-app/old-app_0.9.0_amd64.deb');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(oldAsset.browser_download_url);
  });

  it('respects prerelease variant', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: '' });
    const ctx = createMockExecutionContext();

    const prereleaseAsset = createMockGitHubAsset({
      name: 'beta-app_2.0.0-beta.1_amd64.deb',
      browser_download_url: 'https://github.com/owner/repo/releases/download/v2.0.0-beta.1/beta-app_2.0.0-beta.1_amd64.deb',
    });

    const prereleaseRelease = createMockGitHubRelease({
      id: 99999,
      tag_name: 'v2.0.0-beta.1',
      prerelease: true,
      assets: [prereleaseAsset],
    });

    mockPublicRepo([prereleaseRelease]);

    const request = new Request('https://example.com/owner/repo/prerelease/pool/main/b/beta-app/beta-app_2.0.0-beta.1_amd64.deb');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(prereleaseAsset.browser_download_url);
  });
});

// ============================================================================
// Extended handleReadme Tests
// ============================================================================

describe('handleReadme - extended', () => {
  it('includes cache headers', async () => {
    const env = createMockEnv();
    const ctx = createMockExecutionContext();

    const request = new Request('https://example.com/');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('handles various Accept headers for content negotiation', async () => {
    const env = createMockEnv();

    // Test with curl-style Accept header
    const curlCtx = createMockExecutionContext();
    const curlRequest = new Request('https://example.com/', {
      headers: { 'Accept': '*/*' },
    });
    const curlResponse = await fetchAndFlush(curlRequest, env, curlCtx);
    expect(curlResponse.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');

    // Test with browser Accept header
    const browserCtx = createMockExecutionContext();
    const browserRequest = new Request('https://example.com/', {
      headers: { 'Accept': 'text/html,application/xhtml+xml' },
    });
    const browserResponse = await fetchAndFlush(browserRequest, env, browserCtx);
    expect(browserResponse.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  });

  it('preserves URL protocol in dynamic replacement', async () => {
    const env = createMockEnv();

    // Test HTTP (should preserve)
    const httpCtx = createMockExecutionContext();
    const httpRequest = new Request('http://example.com/');
    const httpResponse = await fetchAndFlush(httpRequest, env, httpCtx);
    const httpText = await httpResponse.text();
    expect(httpText).toContain('http://example.com/');

    // Test HTTPS
    const httpsCtx = createMockExecutionContext();
    const httpsRequest = new Request('https://secure.example.com/');
    const httpsResponse = await fetchAndFlush(httpsRequest, env, httpsCtx);
    const httpsText = await httpsResponse.text();
    expect(httpsText).toContain('https://secure.example.com/');
  });

  it('contains usage instructions for APT and RPM', async () => {
    const env = createMockEnv();
    const ctx = createMockExecutionContext();

    const request = new Request('https://example.com/');
    const response = await fetchAndFlush(request, env, ctx);

    const text = await response.text();
    // Should have APT instructions
    expect(text).toContain('APT');
    // Should have RPM instructions
    expect(text).toContain('RPM');
    // Should have example commands
    expect(text).toContain('deb');
  });
});

// ============================================================================
// Extended handlePublicKey Tests
// ============================================================================

describe('handlePublicKey - extended', () => {
  it('prefers GPG_PUBLIC_KEY over GPG_PRIVATE_KEY', async () => {
    const publicKey = '-----BEGIN PGP PUBLIC KEY BLOCK-----\npublic-key-content\n-----END PGP PUBLIC KEY BLOCK-----';
    const env = createMockEnv({
      GPG_PUBLIC_KEY: publicKey,
      GPG_PRIVATE_KEY: 'some-private-key',
    });
    const ctx = createMockExecutionContext();

    const request = new Request('https://example.com/owner/repo/public.key');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(publicKey);
  });

  it('works with prerelease variant in path', async () => {
    const publicKey = '-----BEGIN PGP PUBLIC KEY BLOCK-----\ntest\n-----END PGP PUBLIC KEY BLOCK-----';
    const env = createMockEnv({ GPG_PUBLIC_KEY: publicKey });
    const ctx = createMockExecutionContext();

    const request = new Request('https://example.com/owner/repo/prerelease/public.key');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(publicKey);
  });

  it('returns correct Content-Type for GPG keys', async () => {
    const publicKey = '-----BEGIN PGP PUBLIC KEY BLOCK-----\ntest\n-----END PGP PUBLIC KEY BLOCK-----';
    const env = createMockEnv({ GPG_PUBLIC_KEY: publicKey });
    const ctx = createMockExecutionContext();

    const request = new Request('https://example.com/owner/repo/public.key');
    const response = await fetchAndFlush(request, env, ctx);

    expect(response.headers.get('Content-Type')).toBe('application/pgp-keys');
  });
});

// ============================================================================
// Route Validation Tests
// ============================================================================

describe('route validation', () => {
  const ctx = createMockExecutionContext();

  it('rejects invalid owner with too long name', async () => {
    const env = createMockEnv();
    const longOwner = 'a'.repeat(50); // GitHub max is 39
    const request = new Request(`https://example.com/${longOwner}/repo/public.key`);

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Invalid owner name');
  });

  it('rejects invalid owner with special characters', async () => {
    const env = createMockEnv();
    const request = new Request('https://example.com/owner@invalid/repo/public.key');

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Invalid owner name');
  });

  it('rejects owner starting with special characters', async () => {
    const env = createMockEnv();
    const request = new Request('https://example.com/-invalid/repo/public.key');

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Invalid owner name');
  });

  it('rejects invalid repo with too long name', async () => {
    const env = createMockEnv();
    const longRepo = 'a'.repeat(150); // GitHub max is 100
    const request = new Request(`https://example.com/owner/${longRepo}/public.key`);

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Invalid repository name');
  });

  it('rejects repo with invalid characters', async () => {
    const env = createMockEnv();
    const request = new Request('https://example.com/owner/repo$invalid/public.key');

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Invalid repository name');
  });

  it('accepts valid GitHub naming patterns', async () => {
    const env = createMockEnv({ GPG_PUBLIC_KEY: 'test-key' });

    const validPaths = [
      '/valid-owner/valid-repo/public.key',
      '/owner123/repo_name/public.key',
      '/Owner/Repo.Name/public.key',
      '/a/b/public.key', // Minimum length
    ];

    for (const path of validPaths) {
      const request = new Request(`https://example.com${path}`);
      const response = await worker.fetch(request, env, ctx);
      // Should not be 400 for valid names
      expect(response.status).not.toBe(400);
    }
  });

  it('returns 400 for missing owner/repo', async () => {
    const env = createMockEnv();
    const request = new Request('https://example.com/onlyowner');

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Invalid repository path');
  });
});

// ============================================================================
// Cache Invalidation Tests
// ============================================================================

describe('cache invalidation', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('clears cache when ?cache=false is passed', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([MOCK_RELEASE_WITH_DEB]);

    const request = new Request('https://example.com/owner/repo/dists/stable/InRelease?cache=false');
    const response = await fetchAndFlush(request, env, ctx);

    // Should still return a valid response
    expect(response.status).toBe(200);
  });
});
