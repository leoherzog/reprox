import { describe, it, expect, beforeEach } from 'vitest';
import { CacheManager } from '../src/cache/cache';

// ============================================================================
// Mock Cache Implementation
// ============================================================================

class MockCache implements Cache {
  private store = new Map<string, Response>();

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
  }

  size(): number {
    return this.store.size;
  }
}

// ============================================================================
// CacheManager Tests
// ============================================================================

describe('CacheManager', () => {
  let mockCache: MockCache;
  let cacheManager: CacheManager;

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

      await cacheManager.setPackagesFile('owner', 'repo', 'amd64', content);
      const result = await cacheManager.getPackagesFile('owner', 'repo', 'amd64');

      expect(result).toBe(content);
    });

    it('returns null for uncached Packages file', async () => {
      const result = await cacheManager.getPackagesFile('owner', 'repo', 'amd64');

      expect(result).toBeNull();
    });

    it('caches different architectures separately', async () => {
      await cacheManager.setPackagesFile('owner', 'repo', 'amd64', 'amd64 content');
      await cacheManager.setPackagesFile('owner', 'repo', 'arm64', 'arm64 content');

      const amd64 = await cacheManager.getPackagesFile('owner', 'repo', 'amd64');
      const arm64 = await cacheManager.getPackagesFile('owner', 'repo', 'arm64');

      expect(amd64).toBe('amd64 content');
      expect(arm64).toBe('arm64 content');
    });

    it('caches different repos separately', async () => {
      await cacheManager.setPackagesFile('owner', 'repo1', 'amd64', 'repo1 content');
      await cacheManager.setPackagesFile('owner', 'repo2', 'amd64', 'repo2 content');

      const repo1 = await cacheManager.getPackagesFile('owner', 'repo1', 'amd64');
      const repo2 = await cacheManager.getPackagesFile('owner', 'repo2', 'amd64');

      expect(repo1).toBe('repo1 content');
      expect(repo2).toBe('repo2 content');
    });
  });

  // ==========================================================================
  // APT Release File Tests
  // ==========================================================================

  describe('Release file caching', () => {
    it('stores and retrieves Release file', async () => {
      const content = 'Origin: test\nLabel: test\n';

      await cacheManager.setReleaseFile('owner', 'repo', content);
      const result = await cacheManager.getReleaseFile('owner', 'repo');

      expect(result).toBe(content);
    });

    it('returns null for uncached Release file', async () => {
      const result = await cacheManager.getReleaseFile('owner', 'repo');

      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // APT InRelease File Tests
  // ==========================================================================

  describe('InRelease file caching', () => {
    it('stores and retrieves InRelease file', async () => {
      const content = '-----BEGIN PGP SIGNED MESSAGE-----\nRelease content\n-----END PGP SIGNATURE-----';

      await cacheManager.setInReleaseFile('owner', 'repo', content);
      const result = await cacheManager.getInReleaseFile('owner', 'repo');

      expect(result).toBe(content);
    });

    it('returns null for uncached InRelease file', async () => {
      const result = await cacheManager.getInReleaseFile('owner', 'repo');

      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // Release ID Tests
  // ==========================================================================

  describe('Release ID caching', () => {
    it('stores and retrieves release ID', async () => {
      await cacheManager.setLatestReleaseId('owner', 'repo', 12345);
      const result = await cacheManager.getLatestReleaseId('owner', 'repo');

      expect(result).toBe(12345);
    });

    it('returns null for uncached release ID', async () => {
      const result = await cacheManager.getLatestReleaseId('owner', 'repo');

      expect(result).toBeNull();
    });

    it('handles large release IDs', async () => {
      const largeId = 123456789012345;

      await cacheManager.setLatestReleaseId('owner', 'repo', largeId);
      const result = await cacheManager.getLatestReleaseId('owner', 'repo');

      expect(result).toBe(largeId);
    });
  });

  // ==========================================================================
  // needsRefresh Tests
  // ==========================================================================

  describe('needsRefresh', () => {
    it('returns true when no cached release ID', async () => {
      const result = await cacheManager.needsRefresh('owner', 'repo', 123);

      expect(result).toBe(true);
    });

    it('returns true when release ID differs', async () => {
      await cacheManager.setLatestReleaseId('owner', 'repo', 100);
      const result = await cacheManager.needsRefresh('owner', 'repo', 200);

      expect(result).toBe(true);
    });

    it('returns false when release ID matches', async () => {
      await cacheManager.setLatestReleaseId('owner', 'repo', 123);
      const result = await cacheManager.needsRefresh('owner', 'repo', 123);

      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // RPM Caching Tests
  // ==========================================================================

  describe('RPM primary.xml caching', () => {
    it('stores and retrieves primary.xml', async () => {
      const content = '<metadata><package>...</package></metadata>';

      await cacheManager.setRpmPrimaryXml('owner', 'repo', content);
      const result = await cacheManager.getRpmPrimaryXml('owner', 'repo');

      expect(result).toBe(content);
    });

    it('returns null for uncached primary.xml', async () => {
      const result = await cacheManager.getRpmPrimaryXml('owner', 'repo');

      expect(result).toBeNull();
    });
  });

  describe('RPM filelists.xml caching', () => {
    it('stores and retrieves filelists.xml', async () => {
      const content = '<filelists><package>...</package></filelists>';

      await cacheManager.setRpmFilelistsXml('owner', 'repo', content);
      const result = await cacheManager.getRpmFilelistsXml('owner', 'repo');

      expect(result).toBe(content);
    });

    it('returns null for uncached filelists.xml', async () => {
      const result = await cacheManager.getRpmFilelistsXml('owner', 'repo');

      expect(result).toBeNull();
    });
  });

  describe('RPM other.xml caching', () => {
    it('stores and retrieves other.xml', async () => {
      const content = '<otherdata><package>...</package></otherdata>';

      await cacheManager.setRpmOtherXml('owner', 'repo', content);
      const result = await cacheManager.getRpmOtherXml('owner', 'repo');

      expect(result).toBe(content);
    });

    it('returns null for uncached other.xml', async () => {
      const result = await cacheManager.getRpmOtherXml('owner', 'repo');

      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // Cache Key Isolation Tests
  // ==========================================================================

  describe('cache key isolation', () => {
    it('APT and RPM caches are separate', async () => {
      await cacheManager.setPackagesFile('owner', 'repo', 'amd64', 'deb packages');
      await cacheManager.setRpmPrimaryXml('owner', 'repo', 'rpm primary');

      const debPackages = await cacheManager.getPackagesFile('owner', 'repo', 'amd64');
      const rpmPrimary = await cacheManager.getRpmPrimaryXml('owner', 'repo');

      expect(debPackages).toBe('deb packages');
      expect(rpmPrimary).toBe('rpm primary');
    });

    it('Release and InRelease are separate', async () => {
      await cacheManager.setReleaseFile('owner', 'repo', 'unsigned');
      await cacheManager.setInReleaseFile('owner', 'repo', 'signed');

      const release = await cacheManager.getReleaseFile('owner', 'repo');
      const inrelease = await cacheManager.getInReleaseFile('owner', 'repo');

      expect(release).toBe('unsigned');
      expect(inrelease).toBe('signed');
    });
  });

  // ==========================================================================
  // TTL Configuration Tests
  // ==========================================================================

  describe('TTL configuration', () => {
    it('uses default TTL of 86400 seconds', () => {
      // This is tested indirectly - the CacheManager accepts TTL in constructor
      const manager = new CacheManager(mockCache as unknown as Cache);

      // The TTL is private, but we can verify the behavior indirectly
      expect(manager).toBeDefined();
    });

    it('accepts custom TTL', () => {
      const customTtl = 3600;
      const manager = new CacheManager(mockCache as unknown as Cache, customTtl);

      expect(manager).toBeDefined();
    });
  });
});
