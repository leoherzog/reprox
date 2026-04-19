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
    // Use a unique owner/repo so the Workers Cache from previous tests in
    // this file (which vitest-pool-workers 0.14 no longer isolates per-test)
    // cannot short-circuit this request with a cached InRelease.
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([]); // Empty releases

    const request = new Request('https://example.com/empty-inrelease-owner/empty-inrelease-repo/dists/stable/InRelease');

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
    // Use a unique owner/repo so the Workers Cache from previous tests in
    // this file (which vitest-pool-workers 0.14 no longer isolates per-test)
    // cannot short-circuit this request with a cached Release.
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([]);

    const request = new Request('https://example.com/empty-release-owner/empty-release-repo/dists/stable/Release');

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

  it('serves an old hash from the blob cache after content has been regenerated', async () => {
    // Regression test for the stale-while-revalidate race. A client that read
    // an old (In)Release and later requests a Packages file by-hash must get
    // exactly those bytes, even if a background refresh has since produced a
    // newer Release referencing different blobs.
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const owner = 'race-owner';
    const repo = 'race-repo';

    // Phase 1: v1 state — one release with one asset (valid digest, so the
    // assets survive filterDebAssets). Fetch Packages to populate the
    // content-addressed blob cache under its SHA256.
    const v1Release = createMockGitHubRelease({
      id: 1,
      tag_name: 'v1',
      assets: [createMockGitHubAsset({
        name: 'pkg_1.0_amd64.deb',
        digest: 'sha256:' + '1'.repeat(64),
        browser_download_url: 'https://github.com/race-owner/race-repo/releases/download/v1/pkg_1.0_amd64.deb',
      })],
    });
    mockGitHubReleasesAPI([v1Release]);

    const ctx1 = createMockExecutionContext();
    const p1 = await fetchAndFlush(
      new Request(`https://example.com/${owner}/${repo}/dists/stable/main/binary-amd64/Packages`),
      env,
      ctx1,
    );
    const v1Content = await p1.text();
    const v1Hash = await (async () => {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v1Content));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    })();

    // Phase 2: upstream changes — a second release with a different asset.
    // A client that fetches Packages at this point gets a different body.
    const v2Release = createMockGitHubRelease({
      id: 2,
      tag_name: 'v2',
      assets: [createMockGitHubAsset({
        name: 'pkg_2.0_amd64.deb',
        digest: 'sha256:' + '2'.repeat(64),
        browser_download_url: 'https://github.com/race-owner/race-repo/releases/download/v2/pkg_2.0_amd64.deb',
      })],
    });
    mockGitHubReleasesAPI([v2Release, v1Release]);

    // Force a fresh generation by invalidating cached top-level metadata.
    const ctx2 = createMockExecutionContext();
    await fetchAndFlush(
      new Request(`https://example.com/${owner}/${repo}/dists/stable/main/binary-amd64/Packages?cache=false`),
      env,
      ctx2,
    );

    // Phase 3: older client asks for Packages by the v1 hash — blob cache
    // must still resolve it to the exact v1 bytes, since content-addressed
    // blobs are immutable and the phase-2 regeneration wrote new blobs under
    // new hashes rather than overwriting.
    const ctx3 = createMockExecutionContext();
    const byHash = await fetchAndFlush(
      new Request(`https://example.com/${owner}/${repo}/dists/stable/main/binary-amd64/by-hash/SHA256/${v1Hash}`),
      env,
      ctx3,
    );

    expect(byHash.status).toBe(200);
    expect(await byHash.text()).toBe(v1Content);
    expect(byHash.headers.get('Cache-Control')).toBe('public, max-age=86400');
  });

  it('404s when the requested blob has aged out of the cache', async () => {
    // A never-written hash (no Packages generation has ever produced it)
    // must 404. Handler does NOT regenerate — that would defeat
    // content-addressing.
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();
    mockGitHubReleasesAPI([MOCK_RELEASE_WITH_DEB]);

    const neverWrittenHash = 'f'.repeat(64);
    const response = await fetchAndFlush(
      new Request(`https://example.com/aged-owner/aged-repo/dists/stable/main/binary-amd64/by-hash/SHA256/${neverWrittenHash}`),
      env,
      ctx,
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toContain('Hash not found');
  });
});

// ============================================================================
// Legacy Packages URL / blob-lookup Tests (task #13)
// ============================================================================

describe('legacy binary-{arch}/Packages URL serves via blob lookup', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('response SHA256 matches what Release advertises', async () => {
    // The core invariant: the bytes returned from
    // `binary-{arch}/Packages[.gz]` must match the SHA256 Release pins.
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const owner = 'legacy-owner';
    const repo = 'legacy-repo';
    const release = createMockGitHubRelease({
      id: 1,
      assets: [createMockGitHubAsset({
        name: 'pkg_1.0_amd64.deb',
        digest: 'sha256:' + 'a'.repeat(64),
        browser_download_url: 'https://github.com/legacy-owner/legacy-repo/releases/download/v1/pkg_1.0_amd64.deb',
      })],
    });
    mockGitHubReleasesAPI([release]);

    // Fetch Release so the SHA256 map is known.
    const ctxRel = createMockExecutionContext();
    const relResp = await fetchAndFlush(
      new Request(`https://example.com/${owner}/${repo}/dists/stable/Release`),
      env,
      ctxRel,
    );
    const relText = await relResp.text();

    // Find the SHA256 Release advertises for main/binary-amd64/Packages.
    const match = relText.match(/^ ([0-9a-f]{64})\s+\d+\s+main\/binary-amd64\/Packages$/m);
    expect(match).not.toBeNull();
    const advertisedSha = match![1];

    // Fetch the legacy URL.
    const ctxPkg = createMockExecutionContext();
    const pkgResp = await fetchAndFlush(
      new Request(`https://example.com/${owner}/${repo}/dists/stable/main/binary-amd64/Packages`),
      env,
      ctxPkg,
    );
    expect(pkgResp.status).toBe(200);
    const pkgBody = await pkgResp.text();

    // Hash the served bytes and compare.
    const bodyHashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pkgBody));
    const bodyHash = Array.from(new Uint8Array(bodyHashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
    expect(bodyHash).toBe(advertisedSha);
  });

  it('Packages.gz body SHA256 matches what Release advertises', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const owner = 'gz-owner';
    const repo = 'gz-repo';
    mockGitHubReleasesAPI([createMockGitHubRelease({
      id: 1,
      assets: [createMockGitHubAsset({
        name: 'pkg_1.0_amd64.deb',
        digest: 'sha256:' + 'b'.repeat(64),
        browser_download_url: 'https://github.com/gz-owner/gz-repo/releases/download/v1/pkg_1.0_amd64.deb',
      })],
    })]);

    const ctxRel = createMockExecutionContext();
    const relResp = await fetchAndFlush(
      new Request(`https://example.com/${owner}/${repo}/dists/stable/Release`),
      env,
      ctxRel,
    );
    const relText = await relResp.text();

    const match = relText.match(/^ ([0-9a-f]{64})\s+\d+\s+main\/binary-amd64\/Packages\.gz$/m);
    expect(match).not.toBeNull();
    const advertisedSha = match![1];

    const ctxGz = createMockExecutionContext();
    const gzResp = await fetchAndFlush(
      new Request(`https://example.com/${owner}/${repo}/dists/stable/main/binary-amd64/Packages.gz`),
      env,
      ctxGz,
    );
    expect(gzResp.status).toBe(200);
    expect(gzResp.headers.get('Content-Type')).toBe('application/gzip');
    const bytes = new Uint8Array(await gzResp.arrayBuffer());

    const bodyHashBuf = await crypto.subtle.digest('SHA-256', bytes);
    const bodyHash = Array.from(new Uint8Array(bodyHashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
    expect(bodyHash).toBe(advertisedSha);
  });

  it('concurrent refresh does not produce a Release/Packages hash mismatch for a client holding old Release', async () => {
    // Simulate: client A fetches Release at v1, gets bytes pinning v1
    // SHA256. Server then refreshes to v2 (rewriting Release). Client A
    // follows up with GET /Packages — under the new design this reads the
    // *current* Release server-side and returns v2 bytes hashing to the v2
    // SHA256, which will mismatch client A's pinned v1 value. BUT — the v1
    // blob is still retrievable via by-hash against the v1 pin, so a modern
    // apt client (Acquire-By-Hash: yes — advertised in Release) is safe.
    // This test asserts exactly that by-hash routing gives v1 whenever
    // by-hash/v1 is requested, regardless of the non-by-hash path being
    // refreshed.
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const owner = 'concurrent-owner';
    const repo = 'concurrent-repo';

    // v1 state
    mockGitHubReleasesAPI([createMockGitHubRelease({
      id: 1,
      tag_name: 'v1',
      assets: [createMockGitHubAsset({
        name: 'pkg_1.0_amd64.deb',
        digest: 'sha256:' + 'c'.repeat(64),
        browser_download_url: 'https://github.com/concurrent-owner/concurrent-repo/releases/download/v1/pkg_1.0_amd64.deb',
      })],
    })]);
    const ctxA = createMockExecutionContext();
    const relA = await fetchAndFlush(
      new Request(`https://example.com/${owner}/${repo}/dists/stable/Release`),
      env,
      ctxA,
    );
    const relATxt = await relA.text();
    const v1ShaMatch = relATxt.match(/^ ([0-9a-f]{64})\s+\d+\s+main\/binary-amd64\/Packages$/m);
    expect(v1ShaMatch).not.toBeNull();
    const v1Sha = v1ShaMatch![1];

    // Server-side refresh to v2
    mockGitHubReleasesAPI([
      createMockGitHubRelease({
        id: 2,
        tag_name: 'v2',
        assets: [createMockGitHubAsset({
          name: 'pkg_2.0_amd64.deb',
          digest: 'sha256:' + 'd'.repeat(64),
          browser_download_url: 'https://github.com/concurrent-owner/concurrent-repo/releases/download/v2/pkg_2.0_amd64.deb',
        })],
      }),
    ]);
    const ctxRefresh = createMockExecutionContext();
    await fetchAndFlush(
      new Request(`https://example.com/${owner}/${repo}/dists/stable/Release?cache=false`),
      env,
      ctxRefresh,
    );

    // Client A (holding v1 Release) follows up with by-hash/v1 — must get
    // the exact v1 Packages bytes whose hash matches the v1 pin.
    const ctxClient = createMockExecutionContext();
    const byHashResp = await fetchAndFlush(
      new Request(`https://example.com/${owner}/${repo}/dists/stable/main/binary-amd64/by-hash/SHA256/${v1Sha}`),
      env,
      ctxClient,
    );
    expect(byHashResp.status).toBe(200);
    const body = await byHashResp.text();
    const bodyHashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
    const bodyHash = Array.from(new Uint8Array(bodyHashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
    expect(bodyHash).toBe(v1Sha);
  });
});

// ============================================================================
// generateAndCacheAll / blob-write ordering Tests
// ============================================================================

describe('APT packages-blob ordering', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('InRelease generation populates by-hash blobs for every Packages referenced', async () => {
    // After serving an InRelease, each SHA256 it names under the SHA256:
    // section must be resolvable via by-hash/SHA256/{hash}. This is the
    // structural invariant that closes the race.
    //
    // We only assert the invariant when the Release actually references
    // Packages files — if the mock's range-request body doesn't parse into
    // a valid control record the Packages file can be empty, but it is
    // still hashed and included, so we expect at least two entries.
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const owner = 'blob-owner';
    const repo = 'blob-repo';
    const releaseWithDigest = createMockGitHubRelease({
      id: 777,
      assets: [createMockGitHubAsset({
        name: 'pkg_1.0_amd64.deb',
        digest: 'sha256:' + 'a'.repeat(64),
        browser_download_url: 'https://github.com/blob-owner/blob-repo/releases/download/v1/pkg_1.0_amd64.deb',
      })],
    });
    mockGitHubReleasesAPI([releaseWithDigest]);

    const ctx = createMockExecutionContext();
    const inrel = await fetchAndFlush(
      new Request(`https://example.com/${owner}/${repo}/dists/stable/InRelease`),
      env,
      ctx,
    );
    const inReleaseText = await inrel.text();

    // Parse every SHA256 hash line (Packages + Packages.gz for each arch).
    const sha256Lines = inReleaseText
      .split('\n')
      .filter(line => /^ [0-9a-f]{64}\s+\d+\s+\S+\/binary-\S+\/Packages(\.gz)?$/.test(line));
    expect(sha256Lines.length).toBeGreaterThanOrEqual(2);

    for (const line of sha256Lines) {
      const parts = line.trim().split(/\s+/);
      const hash = parts[0];
      // Extract arch from the last segment (e.g. `main/binary-amd64/Packages`)
      const archMatch = parts[2].match(/binary-([^/]+)/);
      expect(archMatch).not.toBeNull();
      const arch = archMatch![1];
      const ctxN = createMockExecutionContext();
      const resp = await fetchAndFlush(
        new Request(`https://example.com/${owner}/${repo}/dists/stable/main/binary-${arch}/by-hash/SHA256/${hash}`),
        env,
        ctxN,
      );
      expect(resp.status).toBe(200);
    }
  });
});
