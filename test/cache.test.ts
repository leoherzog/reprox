import { describe, it, expect, beforeEach } from 'vitest';
import { CacheManager, type ReleaseVariant } from '../src/cache/cache';

// ============================================================================
// Mock Cache Implementation
// ============================================================================

class MockCache implements Cache {
  private store = new Map<string, Response>();
  private headers = new Map<string, Headers>();

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const url = request instanceof Request ? request.url : request.toString();
    const cached = this.store.get(url);
    // Return a clone to simulate real cache behavior
    return cached ? cached.clone() : undefined;
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    const url = request instanceof Request ? request.url : request.toString();
    // Clone the response to store it
    this.store.set(url, response.clone());
    // Store headers for verification in tests
    this.headers.set(url, new Headers(response.headers));
  }

  // Required Cache interface methods (not used in tests)
  async add(_request: RequestInfo | URL): Promise<void> {
    throw new Error('Not implemented');
  }

  async addAll(_requests: RequestInfo[]): Promise<void> {
    throw new Error('Not implemented');
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    const url = request instanceof Request ? request.url : request.toString();
    this.headers.delete(url);
    return this.store.delete(url);
  }

  async keys(): Promise<readonly Request[]> {
    return Array.from(this.store.keys()).map(url => new Request(url));
  }

  async matchAll(): Promise<readonly Response[]> {
    return Array.from(this.store.values());
  }

  // Helper for tests
  clear(): void {
    this.store.clear();
    this.headers.clear();
  }

  size(): number {
    return this.store.size;
  }

  // Get stored headers for a URL (for TTL verification)
  getStoredHeaders(url: string): Headers | undefined {
    return this.headers.get(url);
  }
}

// ============================================================================
// CacheManager Tests
// ============================================================================

describe('CacheManager', () => {
  let mockCache: MockCache;
  let cacheManager: CacheManager;
  const variant: ReleaseVariant = 'stable';

  beforeEach(() => {
    mockCache = new MockCache();
    cacheManager = new CacheManager(mockCache as unknown as Cache);
  });

  // ==========================================================================
  // APT Release File Tests
  // ==========================================================================

  describe('Release file caching', () => {
    it('stores and retrieves Release file', async () => {
      const content = 'Origin: test\nLabel: test\n';

      await cacheManager.setReleaseFile('owner', 'repo', variant, content);
      const result = await cacheManager.getReleaseFile('owner', 'repo', variant);

      expect(result).toBe(content);
    });

    it('returns null for uncached Release file', async () => {
      const result = await cacheManager.getReleaseFile('owner', 'repo', variant);

      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // APT InRelease File Tests
  // ==========================================================================

  describe('InRelease file caching', () => {
    it('stores and retrieves InRelease file', async () => {
      const content = '-----BEGIN PGP SIGNED MESSAGE-----\nRelease content\n-----END PGP SIGNATURE-----';

      await cacheManager.setInReleaseFile('owner', 'repo', variant, content);
      const result = await cacheManager.getInReleaseFile('owner', 'repo', variant);

      expect(result).toBe(content);
    });

    it('returns null for uncached InRelease file', async () => {
      const result = await cacheManager.getInReleaseFile('owner', 'repo', variant);

      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // Release IDs Hash Tests
  // ==========================================================================

  describe('Release IDs hash caching', () => {
    it('stores and retrieves release IDs hash', async () => {
      await cacheManager.setReleaseIdsHash('owner', 'repo', variant, '123,456,789');
      const result = await cacheManager.getReleaseIdsHash('owner', 'repo', variant);

      expect(result).toBe('123,456,789');
    });

    it('returns null for uncached release IDs hash', async () => {
      const result = await cacheManager.getReleaseIdsHash('owner', 'repo', variant);

      expect(result).toBeNull();
    });

    it('caches different variants separately', async () => {
      await cacheManager.setReleaseIdsHash('owner', 'repo', 'stable', '123,456');
      await cacheManager.setReleaseIdsHash('owner', 'repo', 'prerelease', '123,456,789');

      const stable = await cacheManager.getReleaseIdsHash('owner', 'repo', 'stable');
      const prerelease = await cacheManager.getReleaseIdsHash('owner', 'repo', 'prerelease');

      expect(stable).toBe('123,456');
      expect(prerelease).toBe('123,456,789');
    });
  });

  // ==========================================================================
  // needsRefresh Tests
  // ==========================================================================

  describe('needsRefresh', () => {
    it('returns true when no cached release IDs hash', async () => {
      const result = await cacheManager.needsRefresh('owner', 'repo', variant, '123,456');

      expect(result).toBe(true);
    });

    it('returns true when release IDs hash differs', async () => {
      await cacheManager.setReleaseIdsHash('owner', 'repo', variant, '100,200');
      const result = await cacheManager.needsRefresh('owner', 'repo', variant, '100,200,300');

      expect(result).toBe(true);
    });

    it('returns false when release IDs hash matches', async () => {
      await cacheManager.setReleaseIdsHash('owner', 'repo', variant, '123,456,789');
      const result = await cacheManager.needsRefresh('owner', 'repo', variant, '123,456,789');

      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // RPM Caching Tests
  // ==========================================================================

  describe('APT Packages blob caching (content-addressed)', () => {
    const hash = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    it('stores and retrieves a blob by SHA256', async () => {
      const body = new TextEncoder().encode('Package: test\nVersion: 1.0\n');
      await cacheManager.setPackagesBlob('owner', 'repo', variant, hash, body, 'text/plain');

      const cached = await cacheManager.getPackagesBlob('owner', 'repo', variant, hash);
      expect(cached).not.toBeNull();
      expect(await cached!.text()).toBe('Package: test\nVersion: 1.0\n');
    });

    it('preserves the stored Content-Type for .gz blobs', async () => {
      const gzipBody = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00]);
      await cacheManager.setPackagesBlob('owner', 'repo', variant, hash, gzipBody, 'application/gzip');

      const cached = await cacheManager.getPackagesBlob('owner', 'repo', variant, hash);
      expect(cached!.headers.get('Content-Type')).toBe('application/gzip');
    });

    it('returns null for uncached blobs', async () => {
      const result = await cacheManager.getPackagesBlob('owner', 'repo', variant, hash);
      expect(result).toBeNull();
    });

    it('isolates blobs by release variant', async () => {
      const body = new TextEncoder().encode('stable packages');
      await cacheManager.setPackagesBlob('owner', 'repo', 'stable', hash, body, 'text/plain');

      const fromPrerelease = await cacheManager.getPackagesBlob('owner', 'repo', 'prerelease', hash);
      expect(fromPrerelease).toBeNull();
    });

    it('keys blobs by their hash so old hashes survive new writes', async () => {
      // Simulates the stale-while-revalidate race: v1 Packages gets hash A,
      // then regeneration produces v2 Packages with hash B. Both blobs must
      // remain retrievable for the old-Release client.
      const hashV1 = '1'.repeat(64);
      const hashV2 = '2'.repeat(64);
      await cacheManager.setPackagesBlob('owner', 'repo', variant, hashV1, new TextEncoder().encode('v1'), 'text/plain');
      await cacheManager.setPackagesBlob('owner', 'repo', variant, hashV2, new TextEncoder().encode('v2'), 'text/plain');

      expect(await (await cacheManager.getPackagesBlob('owner', 'repo', variant, hashV1))!.text()).toBe('v1');
      expect(await (await cacheManager.getPackagesBlob('owner', 'repo', variant, hashV2))!.text()).toBe('v2');
    });

    it('does not collide with rpm blob keyspace', async () => {
      // Same hash, different keyspaces must not share storage.
      await cacheManager.setPackagesBlob('owner', 'repo', variant, hash, new TextEncoder().encode('apt'), 'text/plain');
      await cacheManager.setRpmBlob('owner', 'repo', variant, hash, new TextEncoder().encode('rpm'), 'application/xml');

      expect(await (await cacheManager.getPackagesBlob('owner', 'repo', variant, hash))!.text()).toBe('apt');
      expect(await (await cacheManager.getRpmBlob('owner', 'repo', variant, hash))!.text()).toBe('rpm');
    });
  });

  describe('RPM blob caching (content-addressed)', () => {
    const hash = 'abc123def456abc123def456abc123def456abc123def456abc123def4560000';

    it('stores and retrieves a blob by SHA256', async () => {
      const body = new TextEncoder().encode('<metadata>primary</metadata>');
      await cacheManager.setRpmBlob('owner', 'repo', variant, hash, body, 'application/xml');

      const cached = await cacheManager.getRpmBlob('owner', 'repo', variant, hash);
      expect(cached).not.toBeNull();
      expect(await cached!.text()).toBe('<metadata>primary</metadata>');
    });

    it('preserves the stored Content-Type', async () => {
      const gzipBody = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
      await cacheManager.setRpmBlob('owner', 'repo', variant, hash, gzipBody, 'application/gzip');

      const cached = await cacheManager.getRpmBlob('owner', 'repo', variant, hash);
      expect(cached!.headers.get('Content-Type')).toBe('application/gzip');
    });

    it('returns null for uncached blobs', async () => {
      const result = await cacheManager.getRpmBlob('owner', 'repo', variant, hash);
      expect(result).toBeNull();
    });

    it('isolates blobs by release variant', async () => {
      const body = new TextEncoder().encode('stable body');
      await cacheManager.setRpmBlob('owner', 'repo', 'stable', hash, body, 'application/xml');

      const fromPrerelease = await cacheManager.getRpmBlob('owner', 'repo', 'prerelease', hash);
      expect(fromPrerelease).toBeNull();
    });

    it('keys blobs by their hash, not by kind', async () => {
      // Two different bodies stored under distinct hashes should both be
      // retrievable — no shared key collision between primary/filelists/other.
      const hashA = '1'.repeat(64);
      const hashB = '2'.repeat(64);
      await cacheManager.setRpmBlob('owner', 'repo', variant, hashA, new TextEncoder().encode('A'), 'application/xml');
      await cacheManager.setRpmBlob('owner', 'repo', variant, hashB, new TextEncoder().encode('B'), 'application/xml');

      expect(await (await cacheManager.getRpmBlob('owner', 'repo', variant, hashA))!.text()).toBe('A');
      expect(await (await cacheManager.getRpmBlob('owner', 'repo', variant, hashB))!.text()).toBe('B');
    });
  });

  // ==========================================================================
  // Cache Key Isolation Tests
  // ==========================================================================

  describe('cache key isolation', () => {
    it('APT Release and RPM repomd caches are separate', async () => {
      await cacheManager.setReleaseFile('owner', 'repo', variant, 'apt release');
      await cacheManager.setRpmRepomd('owner', 'repo', variant, 'rpm repomd xml');

      const aptRelease = await cacheManager.getReleaseFile('owner', 'repo', variant);
      const rpmRepomd = await cacheManager.getRpmRepomd('owner', 'repo', variant);

      expect(aptRelease).toBe('apt release');
      expect(rpmRepomd).toBe('rpm repomd xml');
    });

    it('Release and InRelease are separate', async () => {
      await cacheManager.setReleaseFile('owner', 'repo', variant, 'unsigned');
      await cacheManager.setInReleaseFile('owner', 'repo', variant, 'signed');

      const release = await cacheManager.getReleaseFile('owner', 'repo', variant);
      const inrelease = await cacheManager.getInReleaseFile('owner', 'repo', variant);

      expect(release).toBe('unsigned');
      expect(inrelease).toBe('signed');
    });
  });

  // ==========================================================================
  // TTL Configuration Tests
  // ==========================================================================

  describe('TTL configuration', () => {
    const hash = 'd'.repeat(64);

    it('uses default TTL of 86400 seconds for content', async () => {
      const manager = new CacheManager(mockCache as unknown as Cache);
      await manager.setReleaseFile('owner', 'repo', variant, 'content');

      const headers = mockCache.getStoredHeaders('https://reprox.internal/release/stable/owner/repo');
      expect(headers?.get('Cache-Control')).toBe('public, max-age=86400');
    });

    it('uses 300 second TTL for release IDs hash caching', async () => {
      const manager = new CacheManager(mockCache as unknown as Cache);
      await manager.setReleaseIdsHash('owner', 'repo', variant, '123,456');

      const headers = mockCache.getStoredHeaders('https://reprox.internal/release-ids-hash/stable/owner/repo');
      expect(headers?.get('Cache-Control')).toBe('public, max-age=300');
    });

    it('uses custom TTL for content when provided', async () => {
      const customTtl = 3600;
      const manager = new CacheManager(mockCache as unknown as Cache, customTtl);
      await manager.setPackagesBlob('owner', 'repo', variant, hash, new TextEncoder().encode('x'), 'text/plain');

      const headers = mockCache.getStoredHeaders(`https://reprox.internal/packages-blob/stable/owner/repo/${hash}`);
      expect(headers?.get('Cache-Control')).toBe('public, max-age=3600');
    });

    it('custom TTL does not affect release IDs hash TTL', async () => {
      const manager = new CacheManager(mockCache as unknown as Cache, 7200);
      await manager.setReleaseIdsHash('owner', 'repo', variant, '123,456');

      // Release IDs hash should still use 300s TTL regardless of custom content TTL
      const headers = mockCache.getStoredHeaders('https://reprox.internal/release-ids-hash/stable/owner/repo');
      expect(headers?.get('Cache-Control')).toBe('public, max-age=300');
    });
  });

  // ==========================================================================
  // RPM Repomd Caching Tests
  // ==========================================================================

  describe('RPM repomd.xml caching', () => {
    it('stores and retrieves repomd.xml', async () => {
      const content = '<?xml version="1.0"?><repomd>...</repomd>';

      await cacheManager.setRpmRepomd('owner', 'repo', variant, content);
      const result = await cacheManager.getRpmRepomd('owner', 'repo', variant);

      expect(result).toBe(content);
    });

    it('returns null for uncached repomd.xml', async () => {
      const result = await cacheManager.getRpmRepomd('owner', 'repo', variant);

      expect(result).toBeNull();
    });
  });

  describe('RPM repomd.xml.asc caching', () => {
    it('stores and retrieves repomd.xml.asc signature', async () => {
      const signature = '-----BEGIN PGP SIGNATURE-----\n...\n-----END PGP SIGNATURE-----';

      await cacheManager.setRpmRepomdAsc('owner', 'repo', variant, signature);
      const result = await cacheManager.getRpmRepomdAsc('owner', 'repo', variant);

      expect(result).toBe(signature);
    });

    it('returns null for uncached repomd.xml.asc', async () => {
      const result = await cacheManager.getRpmRepomdAsc('owner', 'repo', variant);

      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // clearAllCache Tests
  // ==========================================================================

  describe('clearAllCache', () => {
    it('clears all APT cache entries for a repository', async () => {
      // Set up cache entries
      await cacheManager.setReleaseFile('owner', 'repo', variant, 'release content');
      await cacheManager.setInReleaseFile('owner', 'repo', variant, 'inrelease content');
      await cacheManager.setReleaseGpgSignature('owner', 'repo', variant, 'gpg sig');
      await cacheManager.setReleaseIdsHash('owner', 'repo', variant, '12345');

      // Clear all cache
      await cacheManager.clearAllCache('owner', 'repo');

      // Verify all cleared
      expect(await cacheManager.getReleaseFile('owner', 'repo', variant)).toBeNull();
      expect(await cacheManager.getInReleaseFile('owner', 'repo', variant)).toBeNull();
      expect(await cacheManager.getReleaseGpgSignature('owner', 'repo', variant)).toBeNull();
      expect(await cacheManager.getReleaseIdsHash('owner', 'repo', variant)).toBeNull();
    });

    it('clears repomd.xml and repomd.xml.asc for a repository', async () => {
      await cacheManager.setRpmRepomd('owner', 'repo', variant, 'repomd xml');
      await cacheManager.setRpmRepomdAsc('owner', 'repo', variant, 'repomd asc');

      await cacheManager.clearAllCache('owner', 'repo');

      expect(await cacheManager.getRpmRepomd('owner', 'repo', variant)).toBeNull();
      expect(await cacheManager.getRpmRepomdAsc('owner', 'repo', variant)).toBeNull();
    });

    it('clears both stable and prerelease variants', async () => {
      // Set up cache entries for both variants
      await cacheManager.setReleaseFile('owner', 'repo', 'stable', 'stable release');
      await cacheManager.setReleaseFile('owner', 'repo', 'prerelease', 'prerelease content');

      // Clear all cache
      await cacheManager.clearAllCache('owner', 'repo');

      // Verify both variants cleared
      expect(await cacheManager.getReleaseFile('owner', 'repo', 'stable')).toBeNull();
      expect(await cacheManager.getReleaseFile('owner', 'repo', 'prerelease')).toBeNull();
    });

    it('does not affect other repositories', async () => {
      // Set up cache entries for two repos
      await cacheManager.setReleaseFile('owner', 'repo1', variant, 'repo1 content');
      await cacheManager.setReleaseFile('owner', 'repo2', variant, 'repo2 content');

      // Clear only repo1
      await cacheManager.clearAllCache('owner', 'repo1');

      // Verify repo1 cleared, repo2 still exists
      expect(await cacheManager.getReleaseFile('owner', 'repo1', variant)).toBeNull();
      expect(await cacheManager.getReleaseFile('owner', 'repo2', variant)).toBe('repo2 content');
    });
  });

  // ==========================================================================
  // Edge Case Tests
  // ==========================================================================

  describe('getReleaseIdsHash edge cases', () => {
    it('returns null for empty string cached value', async () => {
      const request = new Request('https://reprox.internal/release-ids-hash/stable/owner/repo');
      await mockCache.put(request, new Response(''));

      const result = await cacheManager.getReleaseIdsHash('owner', 'repo', variant);
      expect(result).toBe('');
    });
  });

  // ==========================================================================
  // Asset URL Caching Tests
  // ==========================================================================

  describe('Asset URL caching', () => {
    const releaseHash = 'abc123def456';

    it('stores and retrieves asset URLs with release hash', async () => {
      const url = 'https://github.com/owner/repo/releases/download/v1.0/pkg.deb';
      await cacheManager.setAssetUrl('owner', 'repo', 'pkg.deb', variant, releaseHash, url);

      const result = await cacheManager.getAssetUrl('owner', 'repo', 'pkg.deb', variant, releaseHash);
      expect(result).toBe(url);
    });

    it('returns null for different release hash (auto-invalidation)', async () => {
      const url = 'https://github.com/owner/repo/releases/download/v1.0/pkg.deb';
      await cacheManager.setAssetUrl('owner', 'repo', 'pkg.deb', variant, releaseHash, url);

      // Different hash should not find the cached URL
      const result = await cacheManager.getAssetUrl('owner', 'repo', 'pkg.deb', variant, 'different-hash');
      expect(result).toBeNull();
    });

    it('stores multiple asset URLs at once', async () => {
      const assets = [
        { name: 'pkg1.deb', browser_download_url: 'https://example.com/pkg1.deb' },
        { name: 'pkg2.deb', browser_download_url: 'https://example.com/pkg2.deb' },
      ];

      await cacheManager.setAssetUrls('owner', 'repo', variant, releaseHash, assets);

      expect(await cacheManager.getAssetUrl('owner', 'repo', 'pkg1.deb', variant, releaseHash))
        .toBe('https://example.com/pkg1.deb');
      expect(await cacheManager.getAssetUrl('owner', 'repo', 'pkg2.deb', variant, releaseHash))
        .toBe('https://example.com/pkg2.deb');
    });

    it('isolates asset URLs by release variant', async () => {
      const url = 'https://example.com/pkg.deb';
      await cacheManager.setAssetUrl('owner', 'repo', 'pkg.deb', 'stable', releaseHash, url);

      // Same filename, different variant should not match
      const result = await cacheManager.getAssetUrl('owner', 'repo', 'pkg.deb', 'prerelease', releaseHash);
      expect(result).toBeNull();
    });
  });
});
