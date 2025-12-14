/**
 * KV Cache Manager
 *
 * Handles caching of package metadata in Cloudflare KV.
 * Key structure:
 * - packages:{owner}:{repo}:{arch} - Generated Packages file content
 * - release:{owner}:{repo} - Generated Release file content
 * - inrelease:{owner}:{repo} - Signed InRelease file content
 * - latest:{owner}:{repo} - Latest release ID for cache validation
 * - rpm:primary:{owner}:{repo} - RPM primary.xml content
 * - rpm:filelists:{owner}:{repo} - RPM filelists.xml content
 * - rpm:other:{owner}:{repo} - RPM other.xml content
 */

export class CacheManager {
  private kv: KVNamespace;
  private defaultTtl: number;

  constructor(kv: KVNamespace, ttlSeconds = 86400) {
    this.kv = kv;
    this.defaultTtl = ttlSeconds;
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
   * Generate cache key for RPM metadata files
   */
  private rpmMetadataKey(owner: string, repo: string, type: 'primary' | 'filelists' | 'other'): string {
    return `rpm:${type}:${owner}:${repo}`;
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
    if (!value) return null;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? null : parsed;
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

  // =============================================================================
  // RPM Caching Methods
  // =============================================================================

  /**
   * Get cached RPM primary.xml content
   */
  async getRpmPrimaryXml(owner: string, repo: string): Promise<string | null> {
    const key = this.rpmMetadataKey(owner, repo, 'primary');
    return this.kv.get(key, 'text');
  }

  /**
   * Store RPM primary.xml content
   */
  async setRpmPrimaryXml(owner: string, repo: string, content: string): Promise<void> {
    const key = this.rpmMetadataKey(owner, repo, 'primary');
    await this.kv.put(key, content, {
      expirationTtl: this.defaultTtl,
    });
  }

  /**
   * Get cached RPM filelists.xml content
   */
  async getRpmFilelistsXml(owner: string, repo: string): Promise<string | null> {
    const key = this.rpmMetadataKey(owner, repo, 'filelists');
    return this.kv.get(key, 'text');
  }

  /**
   * Store RPM filelists.xml content
   */
  async setRpmFilelistsXml(owner: string, repo: string, content: string): Promise<void> {
    const key = this.rpmMetadataKey(owner, repo, 'filelists');
    await this.kv.put(key, content, {
      expirationTtl: this.defaultTtl,
    });
  }

  /**
   * Get cached RPM other.xml content
   */
  async getRpmOtherXml(owner: string, repo: string): Promise<string | null> {
    const key = this.rpmMetadataKey(owner, repo, 'other');
    return this.kv.get(key, 'text');
  }

  /**
   * Store RPM other.xml content
   */
  async setRpmOtherXml(owner: string, repo: string, content: string): Promise<void> {
    const key = this.rpmMetadataKey(owner, repo, 'other');
    await this.kv.put(key, content, {
      expirationTtl: this.defaultTtl,
    });
  }
}

/**
 * Create a cache manager with environment configuration
 */
export function createCacheManager(
  kv: KVNamespace,
  cacheTtl?: string
): CacheManager {
  const parsed = cacheTtl ? parseInt(cacheTtl, 10) : 86400;
  const ttl = isNaN(parsed) ? 86400 : parsed;
  return new CacheManager(kv, ttl);
}
