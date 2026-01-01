/**
 * Cache Manager using Cloudflare Workers Cache API
 *
 * Handles caching of package metadata using the Workers Cache API.
 * Uses synthetic URLs to create cache keys with release variant:
 * - https://reprox.internal/packages/{variant}/{owner}/{repo}/{arch}
 * - https://reprox.internal/release/{variant}/{owner}/{repo}
 * - https://reprox.internal/inrelease/{variant}/{owner}/{repo}
 * - https://reprox.internal/release-ids-hash/{variant}/{owner}/{repo}
 * - https://reprox.internal/rpm/primary/{variant}/{owner}/{repo}
 * - https://reprox.internal/rpm/filelists/{variant}/{owner}/{repo}
 * - https://reprox.internal/rpm/other/{variant}/{owner}/{repo}
 */

import type { GitHubRelease } from '../types';

export type ReleaseVariant = 'stable' | 'prerelease';

/**
 * Compute a simple hash of release IDs for cache invalidation
 */
export function computeReleaseIdsHash(releases: GitHubRelease[]): string {
  return releases.map(r => r.id).sort((a, b) => a - b).join(',');
}

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
  // Key Generation (all keys include variant for stable/prerelease separation)
  // =============================================================================

  private packagesKey(owner: string, repo: string, arch: string, variant: ReleaseVariant): string {
    return `packages/${variant}/${owner}/${repo}/${arch}`;
  }

  private releaseKey(owner: string, repo: string, variant: ReleaseVariant): string {
    return `release/${variant}/${owner}/${repo}`;
  }

  private inReleaseKey(owner: string, repo: string, variant: ReleaseVariant): string {
    return `inrelease/${variant}/${owner}/${repo}`;
  }

  private releaseGpgKey(owner: string, repo: string, variant: ReleaseVariant): string {
    return `release-gpg/${variant}/${owner}/${repo}`;
  }

  private releaseIdsHashKey(owner: string, repo: string, variant: ReleaseVariant): string {
    return `release-ids-hash/${variant}/${owner}/${repo}`;
  }

  private rpmMetadataKey(owner: string, repo: string, type: 'primary' | 'filelists' | 'other', variant: ReleaseVariant): string {
    return `rpm/${type}/${variant}/${owner}/${repo}`;
  }

  private rpmTimestampKey(owner: string, repo: string, variant: ReleaseVariant): string {
    return `rpm/timestamp/${variant}/${owner}/${repo}`;
  }

  private rpmRepomdKey(owner: string, repo: string, variant: ReleaseVariant): string {
    return `rpm/repomd/${variant}/${owner}/${repo}`;
  }

  private rpmRepomdAscKey(owner: string, repo: string, variant: ReleaseVariant): string {
    return `rpm/repomd-asc/${variant}/${owner}/${repo}`;
  }

  private readmeKey(): string {
    return 'readme';
  }

  private assetUrlKey(owner: string, repo: string, filename: string, variant: ReleaseVariant, releaseHash: string): string {
    // Include release hash so URLs auto-invalidate when releases change
    return `asset-url/${variant}/${owner}/${repo}/${releaseHash}/${filename}`;
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
    arch: string,
    variant: ReleaseVariant
  ): Promise<string | null> {
    const key = this.packagesKey(owner, repo, arch, variant);
    return this.getFromCache(key);
  }

  /**
   * Store Packages file content
   */
  async setPackagesFile(
    owner: string,
    repo: string,
    arch: string,
    variant: ReleaseVariant,
    content: string
  ): Promise<void> {
    const key = this.packagesKey(owner, repo, arch, variant);
    await this.putInCache(key, content, this.defaultTtl);
  }

  /**
   * Get cached Release file content
   */
  async getReleaseFile(owner: string, repo: string, variant: ReleaseVariant): Promise<string | null> {
    const key = this.releaseKey(owner, repo, variant);
    return this.getFromCache(key);
  }

  /**
   * Store Release file content
   */
  async setReleaseFile(owner: string, repo: string, variant: ReleaseVariant, content: string): Promise<void> {
    const key = this.releaseKey(owner, repo, variant);
    await this.putInCache(key, content, this.defaultTtl);
  }

  /**
   * Get cached InRelease file content
   */
  async getInReleaseFile(owner: string, repo: string, variant: ReleaseVariant): Promise<string | null> {
    const key = this.inReleaseKey(owner, repo, variant);
    return this.getFromCache(key);
  }

  /**
   * Store InRelease file content
   */
  async setInReleaseFile(owner: string, repo: string, variant: ReleaseVariant, content: string): Promise<void> {
    const key = this.inReleaseKey(owner, repo, variant);
    await this.putInCache(key, content, this.defaultTtl);
  }

  /**
   * Get cached Release.gpg signature
   */
  async getReleaseGpgSignature(owner: string, repo: string, variant: ReleaseVariant): Promise<string | null> {
    const key = this.releaseGpgKey(owner, repo, variant);
    return this.getFromCache(key);
  }

  /**
   * Store Release.gpg signature
   */
  async setReleaseGpgSignature(owner: string, repo: string, variant: ReleaseVariant, signature: string): Promise<void> {
    const key = this.releaseGpgKey(owner, repo, variant);
    await this.putInCache(key, signature, this.defaultTtl);
  }

  // =============================================================================
  // Release IDs Hash Methods (5-minute TTL for freshness validation)
  // =============================================================================

  /**
   * Get cached release IDs hash
   */
  async getReleaseIdsHash(owner: string, repo: string, variant: ReleaseVariant): Promise<string | null> {
    const key = this.releaseIdsHashKey(owner, repo, variant);
    return this.getFromCache(key);
  }

  /**
   * Store release IDs hash (uses shorter TTL for freshness checks)
   */
  async setReleaseIdsHash(
    owner: string,
    repo: string,
    variant: ReleaseVariant,
    hash: string
  ): Promise<void> {
    const key = this.releaseIdsHashKey(owner, repo, variant);
    await this.putInCache(key, hash, this.releaseIdTtl);
  }

  /**
   * Check if cache needs refresh based on release IDs hash comparison
   */
  async needsRefresh(
    owner: string,
    repo: string,
    variant: ReleaseVariant,
    currentHash: string
  ): Promise<boolean> {
    const cachedHash = await this.getReleaseIdsHash(owner, repo, variant);
    return cachedHash !== currentHash;
  }

  // =============================================================================
  // RPM Caching Methods
  // =============================================================================

  /**
   * Get cached RPM primary.xml content
   */
  async getRpmPrimaryXml(owner: string, repo: string, variant: ReleaseVariant): Promise<string | null> {
    const key = this.rpmMetadataKey(owner, repo, 'primary', variant);
    return this.getFromCache(key);
  }

  /**
   * Store RPM primary.xml content
   */
  async setRpmPrimaryXml(owner: string, repo: string, variant: ReleaseVariant, content: string): Promise<void> {
    const key = this.rpmMetadataKey(owner, repo, 'primary', variant);
    await this.putInCache(key, content, this.defaultTtl);
  }

  /**
   * Get cached RPM filelists.xml content
   */
  async getRpmFilelistsXml(owner: string, repo: string, variant: ReleaseVariant): Promise<string | null> {
    const key = this.rpmMetadataKey(owner, repo, 'filelists', variant);
    return this.getFromCache(key);
  }

  /**
   * Store RPM filelists.xml content
   */
  async setRpmFilelistsXml(owner: string, repo: string, variant: ReleaseVariant, content: string): Promise<void> {
    const key = this.rpmMetadataKey(owner, repo, 'filelists', variant);
    await this.putInCache(key, content, this.defaultTtl);
  }

  /**
   * Get cached RPM other.xml content
   */
  async getRpmOtherXml(owner: string, repo: string, variant: ReleaseVariant): Promise<string | null> {
    const key = this.rpmMetadataKey(owner, repo, 'other', variant);
    return this.getFromCache(key);
  }

  /**
   * Store RPM other.xml content
   */
  async setRpmOtherXml(owner: string, repo: string, variant: ReleaseVariant, content: string): Promise<void> {
    const key = this.rpmMetadataKey(owner, repo, 'other', variant);
    await this.putInCache(key, content, this.defaultTtl);
  }

  /**
   * Get cached RPM timestamp (for consistent repomd.xml generation)
   */
  async getRpmTimestamp(owner: string, repo: string, variant: ReleaseVariant): Promise<number | null> {
    const key = this.rpmTimestampKey(owner, repo, variant);
    const value = await this.getFromCache(key);
    if (!value) return null;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? null : parsed;
  }

  /**
   * Store RPM timestamp
   */
  async setRpmTimestamp(owner: string, repo: string, variant: ReleaseVariant, timestamp: number): Promise<void> {
    const key = this.rpmTimestampKey(owner, repo, variant);
    await this.putInCache(key, timestamp.toString(), this.defaultTtl);
  }

  /**
   * Get cached repomd.xml content
   */
  async getRpmRepomd(owner: string, repo: string, variant: ReleaseVariant): Promise<string | null> {
    const key = this.rpmRepomdKey(owner, repo, variant);
    return this.getFromCache(key);
  }

  /**
   * Store repomd.xml content
   */
  async setRpmRepomd(owner: string, repo: string, variant: ReleaseVariant, content: string): Promise<void> {
    const key = this.rpmRepomdKey(owner, repo, variant);
    await this.putInCache(key, content, this.defaultTtl);
  }

  /**
   * Get cached repomd.xml.asc signature
   */
  async getRpmRepomdAsc(owner: string, repo: string, variant: ReleaseVariant): Promise<string | null> {
    const key = this.rpmRepomdAscKey(owner, repo, variant);
    return this.getFromCache(key);
  }

  /**
   * Store repomd.xml.asc signature
   */
  async setRpmRepomdAsc(owner: string, repo: string, variant: ReleaseVariant, content: string): Promise<void> {
    const key = this.rpmRepomdAscKey(owner, repo, variant);
    await this.putInCache(key, content, this.defaultTtl);
  }

  // =============================================================================
  // README Caching Methods
  // =============================================================================

  /**
   * Get cached README content (raw, before dynamic replacements)
   */
  async getReadme(): Promise<string | null> {
    const key = this.readmeKey();
    return this.getFromCache(key);
  }

  /**
   * Store README content (raw, before dynamic replacements)
   */
  async setReadme(content: string): Promise<void> {
    const key = this.readmeKey();
    await this.putInCache(key, content, this.defaultTtl);
  }

  /**
   * Clear cached README content
   */
  async clearReadme(): Promise<void> {
    const key = this.readmeKey();
    await this.cache.delete(this.createCacheRequest(key));
  }

  // =============================================================================
  // Asset URL Caching Methods (for binary download redirects)
  // =============================================================================

  /**
   * Get cached asset download URL
   */
  async getAssetUrl(
    owner: string,
    repo: string,
    filename: string,
    variant: ReleaseVariant,
    releaseHash: string
  ): Promise<string | null> {
    const key = this.assetUrlKey(owner, repo, filename, variant, releaseHash);
    return this.getFromCache(key);
  }

  /**
   * Store asset download URL
   */
  async setAssetUrl(
    owner: string,
    repo: string,
    filename: string,
    variant: ReleaseVariant,
    releaseHash: string,
    url: string
  ): Promise<void> {
    const key = this.assetUrlKey(owner, repo, filename, variant, releaseHash);
    await this.putInCache(key, url, this.defaultTtl);
  }

  /**
   * Store multiple asset URLs at once (called during metadata generation)
   */
  async setAssetUrls(
    owner: string,
    repo: string,
    variant: ReleaseVariant,
    releaseHash: string,
    assets: Array<{ name: string; browser_download_url: string }>
  ): Promise<void> {
    await Promise.all(
      assets.map(asset =>
        this.setAssetUrl(owner, repo, asset.name, variant, releaseHash, asset.browser_download_url)
      )
    );
  }

  /**
   * Clear all cached content for a repository (both stable and prerelease variants)
   */
  async clearAllCache(owner: string, repo: string): Promise<void> {
    const variants: ReleaseVariant[] = ['stable', 'prerelease'];
    const architectures = ['amd64', 'arm64', 'i386', 'armhf', 'all'];
    const keys: string[] = [];

    for (const variant of variants) {
      // APT cache keys
      keys.push(this.releaseKey(owner, repo, variant));
      keys.push(this.inReleaseKey(owner, repo, variant));
      keys.push(this.releaseGpgKey(owner, repo, variant));
      keys.push(this.releaseIdsHashKey(owner, repo, variant));
      // APT Packages files for all known architectures
      for (const arch of architectures) {
        keys.push(this.packagesKey(owner, repo, arch, variant));
      }
      // RPM cache keys
      keys.push(this.rpmMetadataKey(owner, repo, 'primary', variant));
      keys.push(this.rpmMetadataKey(owner, repo, 'filelists', variant));
      keys.push(this.rpmMetadataKey(owner, repo, 'other', variant));
      keys.push(this.rpmTimestampKey(owner, repo, variant));
      keys.push(this.rpmRepomdKey(owner, repo, variant));
      keys.push(this.rpmRepomdAscKey(owner, repo, variant));
    }

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
