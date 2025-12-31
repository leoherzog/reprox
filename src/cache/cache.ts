/**
 * Cache Manager using Cloudflare Workers Cache API
 *
 * Handles caching of package metadata using the Workers Cache API.
 * Uses synthetic URLs to create cache keys:
 * - https://reprox.internal/packages/{owner}/{repo}/{arch}
 * - https://reprox.internal/release/{owner}/{repo}
 * - https://reprox.internal/inrelease/{owner}/{repo}
 * - https://reprox.internal/latest/{owner}/{repo}
 * - https://reprox.internal/rpm/primary/{owner}/{repo}
 * - https://reprox.internal/rpm/filelists/{owner}/{repo}
 * - https://reprox.internal/rpm/other/{owner}/{repo}
 */

// Base URL for synthetic cache requests
const CACHE_BASE_URL = 'https://reprox.internal';

// TTL constants
const RELEASE_ID_TTL = 300; // 5 minutes for freshness validation
const DEFAULT_CONTENT_TTL = 86400; // 24 hours for content

export class CacheManager {
  private cache: Cache;
  private defaultTtl: number;
  private releaseIdTtl: number;

  constructor(cache: Cache, ttlSeconds = DEFAULT_CONTENT_TTL) {
    this.cache = cache;
    this.defaultTtl = ttlSeconds;
    this.releaseIdTtl = RELEASE_ID_TTL;
  }

  /**
   * Create a synthetic Request for cache operations
   */
  private createCacheRequest(key: string): Request {
    return new Request(`${CACHE_BASE_URL}/${key}`);
  }

  /**
   * Get content from cache
   */
  private async getFromCache(key: string): Promise<string | null> {
    const request = this.createCacheRequest(key);
    const response = await this.cache.match(request);
    if (!response) return null;
    return response.text();
  }

  /**
   * Store content in cache
   */
  private async putInCache(key: string, content: string, ttl: number): Promise<void> {
    const request = this.createCacheRequest(key);
    const response = new Response(content, {
      headers: {
        'Content-Type': 'text/plain',
        'Cache-Control': `public, max-age=${ttl}`,
      },
    });
    await this.cache.put(request, response);
  }

  // =============================================================================
  // Key Generation
  // =============================================================================

  private packagesKey(owner: string, repo: string, arch: string): string {
    return `packages/${owner}/${repo}/${arch}`;
  }

  private releaseKey(owner: string, repo: string): string {
    return `release/${owner}/${repo}`;
  }

  private inReleaseKey(owner: string, repo: string): string {
    return `inrelease/${owner}/${repo}`;
  }

  private releaseGpgKey(owner: string, repo: string): string {
    return `release-gpg/${owner}/${repo}`;
  }

  private latestReleaseKey(owner: string, repo: string): string {
    return `latest/${owner}/${repo}`;
  }

  private rpmMetadataKey(owner: string, repo: string, type: 'primary' | 'filelists' | 'other'): string {
    return `rpm/${type}/${owner}/${repo}`;
  }

  private rpmTimestampKey(owner: string, repo: string): string {
    return `rpm/timestamp/${owner}/${repo}`;
  }

  private rpmRepomdKey(owner: string, repo: string): string {
    return `rpm/repomd/${owner}/${repo}`;
  }

  private rpmRepomdAscKey(owner: string, repo: string): string {
    return `rpm/repomd-asc/${owner}/${repo}`;
  }

  // =============================================================================
  // Debian/APT Package Methods
  // =============================================================================

  /**
   * Get cached Packages file content
   */
  async getPackagesFile(
    owner: string,
    repo: string,
    arch: string
  ): Promise<string | null> {
    const key = this.packagesKey(owner, repo, arch);
    return this.getFromCache(key);
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
    await this.putInCache(key, content, this.defaultTtl);
  }

  /**
   * Get cached Release file content
   */
  async getReleaseFile(owner: string, repo: string): Promise<string | null> {
    const key = this.releaseKey(owner, repo);
    return this.getFromCache(key);
  }

  /**
   * Store Release file content
   */
  async setReleaseFile(owner: string, repo: string, content: string): Promise<void> {
    const key = this.releaseKey(owner, repo);
    await this.putInCache(key, content, this.defaultTtl);
  }

  /**
   * Get cached InRelease file content
   */
  async getInReleaseFile(owner: string, repo: string): Promise<string | null> {
    const key = this.inReleaseKey(owner, repo);
    return this.getFromCache(key);
  }

  /**
   * Store InRelease file content
   */
  async setInReleaseFile(owner: string, repo: string, content: string): Promise<void> {
    const key = this.inReleaseKey(owner, repo);
    await this.putInCache(key, content, this.defaultTtl);
  }

  /**
   * Get cached Release.gpg signature
   */
  async getReleaseGpgSignature(owner: string, repo: string): Promise<string | null> {
    const key = this.releaseGpgKey(owner, repo);
    return this.getFromCache(key);
  }

  /**
   * Store Release.gpg signature
   */
  async setReleaseGpgSignature(owner: string, repo: string, signature: string): Promise<void> {
    const key = this.releaseGpgKey(owner, repo);
    await this.putInCache(key, signature, this.defaultTtl);
  }

  // =============================================================================
  // Release ID Methods (5-minute TTL for freshness validation)
  // =============================================================================

  /**
   * Get cached latest release ID
   */
  async getLatestReleaseId(owner: string, repo: string): Promise<number | null> {
    const key = this.latestReleaseKey(owner, repo);
    const value = await this.getFromCache(key);
    if (!value) return null;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? null : parsed;
  }

  /**
   * Store latest release ID (uses shorter TTL for freshness checks)
   */
  async setLatestReleaseId(
    owner: string,
    repo: string,
    releaseId: number
  ): Promise<void> {
    const key = this.latestReleaseKey(owner, repo);
    await this.putInCache(key, releaseId.toString(), this.releaseIdTtl);
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
    return this.getFromCache(key);
  }

  /**
   * Store RPM primary.xml content
   */
  async setRpmPrimaryXml(owner: string, repo: string, content: string): Promise<void> {
    const key = this.rpmMetadataKey(owner, repo, 'primary');
    await this.putInCache(key, content, this.defaultTtl);
  }

  /**
   * Get cached RPM filelists.xml content
   */
  async getRpmFilelistsXml(owner: string, repo: string): Promise<string | null> {
    const key = this.rpmMetadataKey(owner, repo, 'filelists');
    return this.getFromCache(key);
  }

  /**
   * Store RPM filelists.xml content
   */
  async setRpmFilelistsXml(owner: string, repo: string, content: string): Promise<void> {
    const key = this.rpmMetadataKey(owner, repo, 'filelists');
    await this.putInCache(key, content, this.defaultTtl);
  }

  /**
   * Get cached RPM other.xml content
   */
  async getRpmOtherXml(owner: string, repo: string): Promise<string | null> {
    const key = this.rpmMetadataKey(owner, repo, 'other');
    return this.getFromCache(key);
  }

  /**
   * Store RPM other.xml content
   */
  async setRpmOtherXml(owner: string, repo: string, content: string): Promise<void> {
    const key = this.rpmMetadataKey(owner, repo, 'other');
    await this.putInCache(key, content, this.defaultTtl);
  }

  /**
   * Get cached RPM timestamp (for consistent repomd.xml generation)
   */
  async getRpmTimestamp(owner: string, repo: string): Promise<number | null> {
    const key = this.rpmTimestampKey(owner, repo);
    const value = await this.getFromCache(key);
    if (!value) return null;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? null : parsed;
  }

  /**
   * Store RPM timestamp
   */
  async setRpmTimestamp(owner: string, repo: string, timestamp: number): Promise<void> {
    const key = this.rpmTimestampKey(owner, repo);
    await this.putInCache(key, timestamp.toString(), this.defaultTtl);
  }

  /**
   * Get cached repomd.xml content
   */
  async getRpmRepomd(owner: string, repo: string): Promise<string | null> {
    const key = this.rpmRepomdKey(owner, repo);
    return this.getFromCache(key);
  }

  /**
   * Store repomd.xml content
   */
  async setRpmRepomd(owner: string, repo: string, content: string): Promise<void> {
    const key = this.rpmRepomdKey(owner, repo);
    await this.putInCache(key, content, this.defaultTtl);
  }

  /**
   * Get cached repomd.xml.asc signature
   */
  async getRpmRepomdAsc(owner: string, repo: string): Promise<string | null> {
    const key = this.rpmRepomdAscKey(owner, repo);
    return this.getFromCache(key);
  }

  /**
   * Store repomd.xml.asc signature
   */
  async setRpmRepomdAsc(owner: string, repo: string, content: string): Promise<void> {
    const key = this.rpmRepomdAscKey(owner, repo);
    await this.putInCache(key, content, this.defaultTtl);
  }

  /**
   * Clear all cached content for a repository
   */
  async clearAllCache(owner: string, repo: string): Promise<void> {
    const keys = [
      // APT cache keys
      this.releaseKey(owner, repo),
      this.inReleaseKey(owner, repo),
      this.releaseGpgKey(owner, repo),
      this.latestReleaseKey(owner, repo),
      // RPM cache keys
      this.rpmMetadataKey(owner, repo, 'primary'),
      this.rpmMetadataKey(owner, repo, 'filelists'),
      this.rpmMetadataKey(owner, repo, 'other'),
      this.rpmTimestampKey(owner, repo),
      this.rpmRepomdKey(owner, repo),
      this.rpmRepomdAscKey(owner, repo),
    ];

    // Delete all cached entries
    await Promise.all(
      keys.map(key => this.cache.delete(this.createCacheRequest(key)))
    );
  }
}

/**
 * Create a cache manager with environment configuration
 */
export function createCacheManager(cacheTtl?: string): CacheManager {
  const cache = caches.default;
  const parsed = cacheTtl ? parseInt(cacheTtl, 10) : DEFAULT_CONTENT_TTL;
  const ttl = isNaN(parsed) ? DEFAULT_CONTENT_TTL : parsed;
  return new CacheManager(cache, ttl);
}
