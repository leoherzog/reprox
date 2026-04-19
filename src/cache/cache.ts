/**
 * Cache Manager using Cloudflare Workers Cache API
 *
 * Handles caching of package metadata using the Workers Cache API.
 * Uses synthetic URLs to create cache keys with release variant:
 * - https://reprox.internal/packages-blob/{variant}/{owner}/{repo}/{sha256}
 * - https://reprox.internal/release/{variant}/{owner}/{repo}
 * - https://reprox.internal/inrelease/{variant}/{owner}/{repo}
 * - https://reprox.internal/release-gpg/{variant}/{owner}/{repo}
 * - https://reprox.internal/release-ids-hash/{variant}/{owner}/{repo}
 * - https://reprox.internal/rpm/repomd/{variant}/{owner}/{repo}
 * - https://reprox.internal/rpm/repomd-asc/{variant}/{owner}/{repo}
 * - https://reprox.internal/rpm/blob/{variant}/{owner}/{repo}/{sha256}
 *
 * All package-index bodies (APT Packages/Packages.gz, RPM primary/filelists/
 * other .xml/.xml.gz) are stored as immutable content-addressed blobs keyed
 * by their SHA256. (In)Release and repomd.xml pin those SHA256s, so a client
 * holding any historical top-level metadata file can always resolve every
 * reference against the exact bytes that were hashed into it — even after
 * background refresh has produced a new top-level metadata file pointing at
 * different blobs. The legacy non-by-hash APT URL
 * `binary-{arch}/Packages[.gz]` is served by parsing the current Release and
 * looking up the referenced blob; there is no separate mutable cache key.
 */

import type { GitHubRelease } from '../types';
import { sha256 } from '../utils/crypto';

export type ReleaseVariant = 'stable' | 'prerelease';

/**
 * Compute a hash of releases AND their asset digests for cache invalidation.
 * This ensures cache invalidates when:
 * - New releases are created
 * - Releases are deleted
 * - Assets are added/removed/re-uploaded (digest changes)
 *
 * Returns a 16-character hex string (first 16 chars of SHA256).
 */
export async function computeReleaseIdsHash(releases: GitHubRelease[]): Promise<string> {
  // Build a deterministic string from releases and asset digests
  const sortedReleases = [...releases].sort((a, b) => a.id - b.id);

  const hashInput = sortedReleases.map(r => {
    // Sort assets by name for determinism
    const sortedAssets = [...r.assets].sort((a, b) => a.name.localeCompare(b.name));
    const assetDigests = sortedAssets
      .map(a => `${a.name}:${a.digest || a.size}`)
      .join('|');
    return `${r.id}:${assetDigests}`;
  }).join('\n');

  // Return first 16 chars of SHA256 for reasonable key length
  const fullHash = await sha256(hashInput);
  return fullHash.slice(0, 16);
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

  /**
   * Get a raw Response from cache (for binary blobs).
   * Returns the full cached Response so callers can stream the body.
   */
  private async getResponseFromCache(key: string): Promise<Response | null> {
    const request = this.createCacheRequest(key);
    return (await this.cache.match(request)) ?? null;
  }

  /**
   * Store a binary body in cache with a specific Content-Type.
   */
  private async putBytesInCache(
    key: string,
    body: Uint8Array,
    contentType: string,
    ttl: number
  ): Promise<void> {
    const request = this.createCacheRequest(key);
    const response = new Response(body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': `public, max-age=${ttl}`,
      },
    });
    await this.cache.put(request, response);
  }

  // =============================================================================
  // Key Generation (all keys include variant for stable/prerelease separation)
  // =============================================================================

  private packagesBlobKey(owner: string, repo: string, variant: ReleaseVariant, sha256: string): string {
    return `packages-blob/${variant}/${owner}/${repo}/${sha256}`;
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

  private rpmRepomdKey(owner: string, repo: string, variant: ReleaseVariant): string {
    return `rpm/repomd/${variant}/${owner}/${repo}`;
  }

  private rpmRepomdAscKey(owner: string, repo: string, variant: ReleaseVariant): string {
    return `rpm/repomd-asc/${variant}/${owner}/${repo}`;
  }

  private rpmBlobKey(owner: string, repo: string, variant: ReleaseVariant, sha256: string): string {
    return `rpm/blob/${variant}/${owner}/${repo}/${sha256}`;
  }

  private assetUrlKey(owner: string, repo: string, filename: string, variant: ReleaseVariant, releaseHash: string): string {
    // Include release hash so URLs auto-invalidate when releases change
    return `asset-url/${variant}/${owner}/${repo}/${releaseHash}/${filename}`;
  }

  // =============================================================================
  // Debian/APT Package Methods
  // =============================================================================

  /**
   * Retrieve a content-addressed APT Packages blob (either the uncompressed
   * Packages file or its .gz form) keyed by SHA256. Used by both `by-hash/`
   * clients and the legacy `binary-{arch}/Packages[.gz]` handler (which looks
   * up the current Release's SHA256 and then fetches the blob), so the served
   * bytes are always the exact ones the current Release's checksums pin.
   */
  async getPackagesBlob(
    owner: string,
    repo: string,
    variant: ReleaseVariant,
    sha256: string
  ): Promise<Response | null> {
    const key = this.packagesBlobKey(owner, repo, variant, sha256);
    return this.getResponseFromCache(key);
  }

  /**
   * Store a content-addressed APT Packages blob keyed by its SHA256. Blobs
   * are immutable: once written, any (In)Release referencing this hash can
   * be served consistently regardless of later regenerations.
   */
  async setPackagesBlob(
    owner: string,
    repo: string,
    variant: ReleaseVariant,
    sha256: string,
    body: Uint8Array,
    contentType: string
  ): Promise<void> {
    const key = this.packagesBlobKey(owner, repo, variant, sha256);
    await this.putBytesInCache(key, body, contentType, this.defaultTtl);
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

  /**
   * Retrieve a content-addressed RPM metadata blob (primary/filelists/other,
   * either .xml or .xml.gz). Returns the full cached Response so the caller
   * can stream the body directly and preserve the stored Content-Type.
   *
   * The SHA256 key is taken from the <location href> in repomd.xml, so any
   * client holding a valid repomd.xml can always ask for the exact bytes it
   * was told to expect.
   */
  async getRpmBlob(
    owner: string,
    repo: string,
    variant: ReleaseVariant,
    sha256: string
  ): Promise<Response | null> {
    const key = this.rpmBlobKey(owner, repo, variant, sha256);
    return this.getResponseFromCache(key);
  }

  /**
   * Store a content-addressed RPM metadata blob keyed by its SHA256.
   * Blobs are immutable: once written, any repomd.xml referencing this hash
   * can be served consistently regardless of later regenerations.
   */
  async setRpmBlob(
    owner: string,
    repo: string,
    variant: ReleaseVariant,
    sha256: string,
    body: Uint8Array,
    contentType: string
  ): Promise<void> {
    const key = this.rpmBlobKey(owner, repo, variant, sha256);
    await this.putBytesInCache(key, body, contentType, this.defaultTtl);
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
   * Clear all cached top-level metadata for a repository (both stable and
   * prerelease variants). Content-addressed blobs (`packages-blob/...`,
   * `rpm/blob/...`) are keyed by sha256 and cannot be enumerated, so we rely
   * on their TTL for eviction — but clearing the release-ids-hash here forces
   * the next request to regenerate, and any client whose last request was
   * served against the now-cleared top-level files will fetch fresh hashes
   * and thus new blobs on its next round-trip.
   */
  async clearAllCache(owner: string, repo: string): Promise<void> {
    const variants: ReleaseVariant[] = ['stable', 'prerelease'];
    const keys: string[] = [];

    for (const variant of variants) {
      keys.push(this.releaseKey(owner, repo, variant));
      keys.push(this.inReleaseKey(owner, repo, variant));
      keys.push(this.releaseGpgKey(owner, repo, variant));
      keys.push(this.releaseIdsHashKey(owner, repo, variant));
      keys.push(this.rpmRepomdKey(owner, repo, variant));
      keys.push(this.rpmRepomdAscKey(owner, repo, variant));
    }

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
