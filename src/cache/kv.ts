import type { CachedMetadata, PackageEntry } from '../types';

/**
 * KV Cache Manager
 *
 * Handles caching of package metadata in Cloudflare KV.
 * Key structure:
 * - meta:{owner}:{repo}:{releaseId} - Full package metadata for a release
 * - packages:{owner}:{repo}:{arch} - Generated Packages file content
 * - release:{owner}:{repo} - Generated Release file content
 * - inrelease:{owner}:{repo} - Signed InRelease file content
 */

export class CacheManager {
  private kv: KVNamespace;
  private defaultTtl: number;

  constructor(kv: KVNamespace, ttlSeconds = 86400) {
    this.kv = kv;
    this.defaultTtl = ttlSeconds;
  }

  /**
   * Generate cache key for metadata
   */
  private metaKey(owner: string, repo: string, releaseId: number): string {
    return `meta:${owner}:${repo}:${releaseId}`;
  }

  /**
   * Generate cache key for Packages file
   */
  private packagesKey(owner: string, repo: string, arch: string): string {
    return `packages:${owner}:${repo}:${arch}`;
  }

  /**
   * Generate cache key for Release file
   */
  private releaseKey(owner: string, repo: string): string {
    return `release:${owner}:${repo}`;
  }

  /**
   * Generate cache key for InRelease file
   */
  private inReleaseKey(owner: string, repo: string): string {
    return `inrelease:${owner}:${repo}`;
  }

  /**
   * Generate cache key for latest release ID
   */
  private latestReleaseKey(owner: string, repo: string): string {
    return `latest:${owner}:${repo}`;
  }

  /**
   * Get cached metadata for a specific release
   */
  async getMetadata(
    owner: string,
    repo: string,
    releaseId: number
  ): Promise<CachedMetadata | null> {
    const key = this.metaKey(owner, repo, releaseId);
    const cached = await this.kv.get(key, 'json');
    return cached as CachedMetadata | null;
  }

  /**
   * Store metadata for a release
   */
  async setMetadata(
    owner: string,
    repo: string,
    releaseId: number,
    metadata: CachedMetadata
  ): Promise<void> {
    const key = this.metaKey(owner, repo, releaseId);
    await this.kv.put(key, JSON.stringify(metadata), {
      expirationTtl: this.defaultTtl,
    });
  }

  /**
   * Get cached Packages file content
   */
  async getPackagesFile(
    owner: string,
    repo: string,
    arch: string
  ): Promise<string | null> {
    const key = this.packagesKey(owner, repo, arch);
    return this.kv.get(key, 'text');
  }

  /**
   * Store Packages file content
   */
  async setPackagesFile(
    owner: string,
    repo: string,
    arch: string,
    content: string
  ): Promise<void> {
    const key = this.packagesKey(owner, repo, arch);
    await this.kv.put(key, content, {
      expirationTtl: this.defaultTtl,
    });
  }

  /**
   * Get cached Release file content
   */
  async getReleaseFile(owner: string, repo: string): Promise<string | null> {
    const key = this.releaseKey(owner, repo);
    return this.kv.get(key, 'text');
  }

  /**
   * Store Release file content
   */
  async setReleaseFile(owner: string, repo: string, content: string): Promise<void> {
    const key = this.releaseKey(owner, repo);
    await this.kv.put(key, content, {
      expirationTtl: this.defaultTtl,
    });
  }

  /**
   * Get cached InRelease file content
   */
  async getInReleaseFile(owner: string, repo: string): Promise<string | null> {
    const key = this.inReleaseKey(owner, repo);
    return this.kv.get(key, 'text');
  }

  /**
   * Store InRelease file content
   */
  async setInReleaseFile(owner: string, repo: string, content: string): Promise<void> {
    const key = this.inReleaseKey(owner, repo);
    await this.kv.put(key, content, {
      expirationTtl: this.defaultTtl,
    });
  }

  /**
   * Get cached latest release ID
   */
  async getLatestReleaseId(owner: string, repo: string): Promise<number | null> {
    const key = this.latestReleaseKey(owner, repo);
    const value = await this.kv.get(key, 'text');
    return value ? parseInt(value, 10) : null;
  }

  /**
   * Store latest release ID
   */
  async setLatestReleaseId(
    owner: string,
    repo: string,
    releaseId: number
  ): Promise<void> {
    const key = this.latestReleaseKey(owner, repo);
    await this.kv.put(key, releaseId.toString(), {
      expirationTtl: this.defaultTtl,
    });
  }

  /**
   * Check if cache needs refresh based on release ID comparison
   */
  async needsRefresh(
    owner: string,
    repo: string,
    currentReleaseId: number
  ): Promise<boolean> {
    const cachedReleaseId = await this.getLatestReleaseId(owner, repo);
    return cachedReleaseId !== currentReleaseId;
  }

  /**
   * Invalidate all cache for a repository
   */
  async invalidateRepo(owner: string, repo: string): Promise<void> {
    // Note: KV doesn't support prefix deletion directly
    // We'll delete known keys
    const keysToDelete = [
      this.releaseKey(owner, repo),
      this.inReleaseKey(owner, repo),
      this.latestReleaseKey(owner, repo),
    ];

    // Add common architecture keys
    const architectures = ['amd64', 'arm64', 'i386', 'armhf', 'all'];
    for (const arch of architectures) {
      keysToDelete.push(this.packagesKey(owner, repo, arch));
    }

    await Promise.all(keysToDelete.map(key => this.kv.delete(key)));
  }

  /**
   * Get all package entries from metadata
   */
  async getAllPackages(
    owner: string,
    repo: string,
    releaseId: number
  ): Promise<PackageEntry[]> {
    const metadata = await this.getMetadata(owner, repo, releaseId);
    return metadata?.packages || [];
  }
}

/**
 * Create a cache manager with environment configuration
 */
export function createCacheManager(
  kv: KVNamespace,
  cacheTtl?: string
): CacheManager {
  const ttl = cacheTtl ? parseInt(cacheTtl, 10) : 86400;
  return new CacheManager(kv, ttl);
}
