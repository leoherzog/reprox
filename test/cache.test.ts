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
  // APT Packages File Tests
  // ==========================================================================

  describe('Packages file caching', () => {
    it('stores and retrieves Packages file', async () => {
      const content = 'Package: test\nVersion: 1.0\n';

      await cacheManager.setPackagesFile('owner', 'repo', 'amd64', variant, content);
      const result = await cacheManager.getPackagesFile('owner', 'repo', 'amd64', variant);

      expect(result).toBe(content);
    });

    it('returns null for uncached Packages file', async () => {
      const result = await cacheManager.getPackagesFile('owner', 'repo', 'amd64', variant);

      expect(result).toBeNull();
    });

    it('caches different architectures separately', async () => {
      await cacheManager.setPackagesFile('owner', 'repo', 'amd64', variant, 'amd64 content');
      await cacheManager.setPackagesFile('owner', 'repo', 'arm64', variant, 'arm64 content');

      const amd64 = await cacheManager.getPackagesFile('owner', 'repo', 'amd64', variant);
      const arm64 = await cacheManager.getPackagesFile('owner', 'repo', 'arm64', variant);

      expect(amd64).toBe('amd64 content');
      expect(arm64).toBe('arm64 content');
    });

    it('caches different repos separately', async () => {
      await cacheManager.setPackagesFile('owner', 'repo1', 'amd64', variant, 'repo1 content');
      await cacheManager.setPackagesFile('owner', 'repo2', 'amd64', variant, 'repo2 content');

      const repo1 = await cacheManager.getPackagesFile('owner', 'repo1', 'amd64', variant);
      const repo2 = await cacheManager.getPackagesFile('owner', 'repo2', 'amd64', variant);

      expect(repo1).toBe('repo1 content');
      expect(repo2).toBe('repo2 content');
    });

    it('caches different variants separately', async () => {
      await cacheManager.setPackagesFile('owner', 'repo', 'amd64', 'stable', 'stable content');
      await cacheManager.setPackagesFile('owner', 'repo', 'amd64', 'prerelease', 'prerelease content');

      const stable = await cacheManager.getPackagesFile('owner', 'repo', 'amd64', 'stable');
      const prerelease = await cacheManager.getPackagesFile('owner', 'repo', 'amd64', 'prerelease');

      expect(stable).toBe('stable content');
      expect(prerelease).toBe('prerelease content');
    });
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

  describe('RPM primary.xml caching', () => {
    it('stores and retrieves primary.xml', async () => {
      const content = '<metadata><package>...</package></metadata>';

      await cacheManager.setRpmPrimaryXml('owner', 'repo', variant, content);
      const result = await cacheManager.getRpmPrimaryXml('owner', 'repo', variant);

      expect(result).toBe(content);
    });

    it('returns null for uncached primary.xml', async () => {
      const result = await cacheManager.getRpmPrimaryXml('owner', 'repo', variant);

      expect(result).toBeNull();
    });
  });

  describe('RPM filelists.xml caching', () => {
    it('stores and retrieves filelists.xml', async () => {
      const content = '<filelists><package>...</package></filelists>';

      await cacheManager.setRpmFilelistsXml('owner', 'repo', variant, content);
      const result = await cacheManager.getRpmFilelistsXml('owner', 'repo', variant);

      expect(result).toBe(content);
    });

    it('returns null for uncached filelists.xml', async () => {
      const result = await cacheManager.getRpmFilelistsXml('owner', 'repo', variant);

      expect(result).toBeNull();
    });
  });

  describe('RPM other.xml caching', () => {
    it('stores and retrieves other.xml', async () => {
      const content = '<otherdata><package>...</package></otherdata>';

      await cacheManager.setRpmOtherXml('owner', 'repo', variant, content);
      const result = await cacheManager.getRpmOtherXml('owner', 'repo', variant);

      expect(result).toBe(content);
    });

    it('returns null for uncached other.xml', async () => {
      const result = await cacheManager.getRpmOtherXml('owner', 'repo', variant);

      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // Cache Key Isolation Tests
  // ==========================================================================

  describe('cache key isolation', () => {
    it('APT and RPM caches are separate', async () => {
      await cacheManager.setPackagesFile('owner', 'repo', 'amd64', variant, 'deb packages');
      await cacheManager.setRpmPrimaryXml('owner', 'repo', variant, 'rpm primary');

      const debPackages = await cacheManager.getPackagesFile('owner', 'repo', 'amd64', variant);
      const rpmPrimary = await cacheManager.getRpmPrimaryXml('owner', 'repo', variant);

      expect(debPackages).toBe('deb packages');
      expect(rpmPrimary).toBe('rpm primary');
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
    it('uses default TTL of 86400 seconds for content', async () => {
      const manager = new CacheManager(mockCache as unknown as Cache);
      await manager.setPackagesFile('owner', 'repo', 'amd64', variant, 'content');

      const headers = mockCache.getStoredHeaders('https://reprox.internal/packages/stable/owner/repo/amd64');
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
      await manager.setPackagesFile('owner', 'repo', 'amd64', variant, 'content');

      const headers = mockCache.getStoredHeaders('https://reprox.internal/packages/stable/owner/repo/amd64');
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

  describe('RPM timestamp caching', () => {
    it('stores and retrieves timestamp', async () => {
      const timestamp = 1700000000;

      await cacheManager.setRpmTimestamp('owner', 'repo', variant, timestamp);
      const result = await cacheManager.getRpmTimestamp('owner', 'repo', variant);

      expect(result).toBe(timestamp);
    });

    it('returns null for uncached timestamp', async () => {
      const result = await cacheManager.getRpmTimestamp('owner', 'repo', variant);

      expect(result).toBeNull();
    });

    it('handles large timestamps', async () => {
      const largeTimestamp = 9999999999999;

      await cacheManager.setRpmTimestamp('owner', 'repo', variant, largeTimestamp);
      const result = await cacheManager.getRpmTimestamp('owner', 'repo', variant);

      expect(result).toBe(largeTimestamp);
    });

    it('returns null for non-numeric cached values', async () => {
      const request = new Request('https://reprox.internal/rpm/timestamp/stable/owner/repo');
      await mockCache.put(request, new Response('not-a-number'));

      const result = await cacheManager.getRpmTimestamp('owner', 'repo', variant);
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

    it('clears all RPM cache entries for a repository', async () => {
      // Set up cache entries
      await cacheManager.setRpmPrimaryXml('owner', 'repo', variant, 'primary xml');
      await cacheManager.setRpmFilelistsXml('owner', 'repo', variant, 'filelists xml');
      await cacheManager.setRpmOtherXml('owner', 'repo', variant, 'other xml');
      await cacheManager.setRpmTimestamp('owner', 'repo', variant, 1700000000);
      await cacheManager.setRpmRepomd('owner', 'repo', variant, 'repomd xml');
      await cacheManager.setRpmRepomdAsc('owner', 'repo', variant, 'repomd asc');

      // Clear all cache
      await cacheManager.clearAllCache('owner', 'repo');

      // Verify all cleared
      expect(await cacheManager.getRpmPrimaryXml('owner', 'repo', variant)).toBeNull();
      expect(await cacheManager.getRpmFilelistsXml('owner', 'repo', variant)).toBeNull();
      expect(await cacheManager.getRpmOtherXml('owner', 'repo', variant)).toBeNull();
      expect(await cacheManager.getRpmTimestamp('owner', 'repo', variant)).toBeNull();
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
});
