/**
 * Shared Test Utilities for Reprox
 *
 * This module provides common test helpers, mock factories, and test data builders
 * used across multiple test files.
 */

import { vi } from 'vitest';
import type { Env } from '../../src/types';

// ============================================================================
// Mock Environment Factories
// ============================================================================

/**
 * Create a mock Cloudflare Workers environment
 */
export function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_TOKEN: 'test-token',
    GPG_PRIVATE_KEY: '',
    GPG_PASSPHRASE: '',
    CACHE_TTL: '86400',
    ...overrides,
  } as Env;
}

/**
 * Enhanced mock ExecutionContext with promise tracking
 */
export interface MockExecutionContext extends ExecutionContext {
  waitUntilPromises: Promise<unknown>[];
  flushWaitUntil: () => Promise<void>;
}

/**
 * Create a mock ExecutionContext for Cloudflare Workers
 * with ability to track and flush waitUntil promises
 */
export function createMockExecutionContext(): MockExecutionContext {
  const waitUntilPromises: Promise<unknown>[] = [];
  return {
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    }),
    passThroughOnException: vi.fn(),
    waitUntilPromises,
    flushWaitUntil: async () => {
      await Promise.all(waitUntilPromises);
    },
  };
}

// ============================================================================
// Mock Cache Implementation
// ============================================================================

/**
 * Mock Cache implementation for testing cache operations
 */
export class MockCache implements Cache {
  private store = new Map<string, Response>();
  private headers = new Map<string, Headers>();

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const url = request instanceof Request ? request.url : request.toString();
    const cached = this.store.get(url);
    return cached ? cached.clone() : undefined;
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    const url = request instanceof Request ? request.url : request.toString();
    this.store.set(url, response.clone());
    this.headers.set(url, new Headers(response.headers));
  }

  // Required Cache interface methods (not used in tests but required by interface)
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

  // Test utility methods
  clear(): void {
    this.store.clear();
    this.headers.clear();
  }

  size(): number {
    return this.store.size;
  }

  getStoredHeaders(url: string): Headers | undefined {
    return this.headers.get(url);
  }
}

// ============================================================================
// Test Data Builders - Debian/APT
// ============================================================================

import type { DebianControlData, PackageEntry, AssetLike } from '../../src/types';

/**
 * Create Debian control data with sensible defaults
 */
export function createControlData(overrides: Partial<DebianControlData> = {}): DebianControlData {
  return {
    package: 'test-pkg',
    version: '1.0.0',
    architecture: 'amd64',
    maintainer: 'Test <test@example.com>',
    installedSize: 1234,
    depends: '',
    recommends: '',
    suggests: '',
    conflicts: '',
    replaces: '',
    provides: '',
    section: 'utils',
    priority: 'optional',
    homepage: '',
    description: 'Test package description',
    ...overrides,
  };
}

/**
 * Create a package entry with sensible defaults
 */
export function createPackageEntry(overrides: Partial<PackageEntry> = {}): PackageEntry {
  return {
    controlData: createControlData(overrides.controlData),
    filename: 'pool/main/t/test-pkg/test-pkg_1.0.0_amd64.deb',
    size: 50000,
    sha256: '',
    md5sum: '',
    ...overrides,
  };
}

/**
 * Create an asset-like object for testing
 */
export function createAsset(overrides: Partial<AssetLike> = {}): AssetLike {
  return {
    name: 'test-package_1.0.0_amd64.deb',
    size: 10000,
    browser_download_url: 'https://github.com/owner/repo/releases/download/v1.0.0/test-package_1.0.0_amd64.deb',
    ...overrides,
  };
}

// ============================================================================
// Test Data Builders - RPM
// ============================================================================

import type { RpmPackageEntry, RpmHeaderData } from '../../src/types';

/**
 * Create RPM header data with sensible defaults
 */
export function createRpmHeaderData(overrides: Partial<RpmHeaderData> = {}): RpmHeaderData {
  return {
    name: 'test-package',
    version: '1.0.0',
    release: '1',
    epoch: 0,
    arch: 'x86_64',
    summary: 'Test package summary',
    description: 'Test package description',
    license: 'MIT',
    url: 'https://example.com',
    group: '',
    vendor: '',
    packager: '',
    buildTime: 1700000000,
    sourceRpm: 'test-package-1.0.0-1.src.rpm',
    installedSize: 0,
    requires: [],
    provides: [],
    obsoletes: [],
    conflicts: [],
    files: [],
    changelog: [],
    ...overrides,
  };
}

/**
 * Create an RPM package entry with sensible defaults
 */
export function createRpmPackageEntry(overrides: Partial<RpmPackageEntry> = {}): RpmPackageEntry {
  return {
    headerData: createRpmHeaderData(overrides.headerData),
    filename: 'test-package-1.0.0-1.x86_64.rpm',
    size: 50000,
    checksum: 'abc123def456',
    checksumType: 'sha256',
    ...overrides,
  };
}

// ============================================================================
// Fetch Mock Utilities
// ============================================================================

/**
 * Setup fetch mock for a test suite.
 * Call in beforeEach, and call vi.unstubAllGlobals() in afterEach.
 */
export function setupFetchMock(): void {
  vi.stubGlobal('fetch', vi.fn());
}

/**
 * Mock a successful fetch response
 */
export function mockFetchSuccess(data: unknown): void {
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as Response);
}

/**
 * Mock a fetch error response
 */
export function mockFetchError(status: number, statusText: string): void {
  vi.mocked(fetch).mockResolvedValue({
    ok: false,
    status,
    statusText,
  } as Response);
}

// ============================================================================
// Test Data Builders - GitHub API
// ============================================================================

import type { GitHubRelease } from '../../src/types';

/**
 * Create a mock GitHub release object
 */
export function createMockGitHubRelease(overrides: Partial<GitHubRelease> = {}): GitHubRelease {
  return {
    id: 12345,
    tag_name: 'v1.0.0',
    name: 'Release 1.0.0',
    body: 'Release notes',
    published_at: '2024-01-15T12:00:00Z',
    prerelease: false,
    assets: [],
    ...overrides,
  };
}

/**
 * Create a mock GitHub asset
 */
export function createMockGitHubAsset(overrides: Partial<GitHubRelease['assets'][0]> = {}): GitHubRelease['assets'][0] {
  return {
    name: 'test-package_1.0.0_amd64.deb',
    size: 50000,
    browser_download_url: 'https://github.com/owner/repo/releases/download/v1.0.0/test-package_1.0.0_amd64.deb',
    ...overrides,
  };
}

// ============================================================================
// Mock CacheManager for Handler Testing
// ============================================================================

import type { ReleaseVariant } from '../../src/cache/cache';

/**
 * Mock CacheManager that stores data in memory for testing
 */
export class MockCacheManager {
  private store = new Map<string, string>();

  // Configure what the cache returns
  private releaseIdsHash: string | null = null;
  private inReleaseFile: string | null = null;
  private releaseFile: string | null = null;
  private releaseGpgSignature: string | null = null;
  private packagesFiles = new Map<string, string>();
  private rpmMetadata = new Map<string, string>();
  private rpmTimestamp: number | null = null;
  private assetUrls = new Map<string, string>();

  // Track method calls for assertions
  public calls = {
    getReleaseIdsHash: 0,
    setReleaseIdsHash: 0,
    getInReleaseFile: 0,
    setInReleaseFile: 0,
    getReleaseFile: 0,
    setReleaseFile: 0,
    getReleaseGpgSignature: 0,
    setReleaseGpgSignature: 0,
    getPackagesFile: 0,
    setPackagesFile: 0,
    needsRefresh: 0,
  };

  // Configuration methods
  setCachedReleaseIdsHash(hash: string | null): void {
    this.releaseIdsHash = hash;
  }

  setCachedInReleaseFile(content: string | null): void {
    this.inReleaseFile = content;
  }

  setCachedReleaseFile(content: string | null): void {
    this.releaseFile = content;
  }

  setCachedReleaseGpgSignature(signature: string | null): void {
    this.releaseGpgSignature = signature;
  }

  setCachedPackagesFile(arch: string, content: string): void {
    this.packagesFiles.set(arch, content);
  }

  setCachedRpmMetadata(type: string, content: string): void {
    this.rpmMetadata.set(type, content);
  }

  setCachedRpmTimestamp(timestamp: number): void {
    this.rpmTimestamp = timestamp;
  }

  // CacheManager interface implementation
  async getReleaseIdsHash(_owner: string, _repo: string, _variant: ReleaseVariant): Promise<string | null> {
    this.calls.getReleaseIdsHash++;
    return this.releaseIdsHash;
  }

  async setReleaseIdsHash(_owner: string, _repo: string, _variant: ReleaseVariant, hash: string): Promise<void> {
    this.calls.setReleaseIdsHash++;
    this.releaseIdsHash = hash;
  }

  async getInReleaseFile(_owner: string, _repo: string, _variant: ReleaseVariant): Promise<string | null> {
    this.calls.getInReleaseFile++;
    return this.inReleaseFile;
  }

  async setInReleaseFile(_owner: string, _repo: string, _variant: ReleaseVariant, content: string): Promise<void> {
    this.calls.setInReleaseFile++;
    this.inReleaseFile = content;
  }

  async getReleaseFile(_owner: string, _repo: string, _variant: ReleaseVariant): Promise<string | null> {
    this.calls.getReleaseFile++;
    return this.releaseFile;
  }

  async setReleaseFile(_owner: string, _repo: string, _variant: ReleaseVariant, content: string): Promise<void> {
    this.calls.setReleaseFile++;
    this.releaseFile = content;
  }

  async getReleaseGpgSignature(_owner: string, _repo: string, _variant: ReleaseVariant): Promise<string | null> {
    this.calls.getReleaseGpgSignature++;
    return this.releaseGpgSignature;
  }

  async setReleaseGpgSignature(_owner: string, _repo: string, _variant: ReleaseVariant, signature: string): Promise<void> {
    this.calls.setReleaseGpgSignature++;
    this.releaseGpgSignature = signature;
  }

  async getPackagesFile(_owner: string, _repo: string, arch: string, _variant: ReleaseVariant): Promise<string | null> {
    this.calls.getPackagesFile++;
    return this.packagesFiles.get(arch) || null;
  }

  async setPackagesFile(_owner: string, _repo: string, arch: string, _variant: ReleaseVariant, content: string): Promise<void> {
    this.calls.setPackagesFile++;
    this.packagesFiles.set(arch, content);
  }

  async needsRefresh(_owner: string, _repo: string, _variant: ReleaseVariant, currentHash: string): Promise<boolean> {
    this.calls.needsRefresh++;
    return this.releaseIdsHash !== currentHash;
  }

  // RPM methods
  async getRpmPrimaryXml(_owner: string, _repo: string, _variant: ReleaseVariant): Promise<string | null> {
    return this.rpmMetadata.get('primary') || null;
  }

  async setRpmPrimaryXml(_owner: string, _repo: string, _variant: ReleaseVariant, content: string): Promise<void> {
    this.rpmMetadata.set('primary', content);
  }

  async getRpmFilelistsXml(_owner: string, _repo: string, _variant: ReleaseVariant): Promise<string | null> {
    return this.rpmMetadata.get('filelists') || null;
  }

  async setRpmFilelistsXml(_owner: string, _repo: string, _variant: ReleaseVariant, content: string): Promise<void> {
    this.rpmMetadata.set('filelists', content);
  }

  async getRpmOtherXml(_owner: string, _repo: string, _variant: ReleaseVariant): Promise<string | null> {
    return this.rpmMetadata.get('other') || null;
  }

  async setRpmOtherXml(_owner: string, _repo: string, _variant: ReleaseVariant, content: string): Promise<void> {
    this.rpmMetadata.set('other', content);
  }

  async getRpmTimestamp(_owner: string, _repo: string, _variant: ReleaseVariant): Promise<number | null> {
    return this.rpmTimestamp;
  }

  async setRpmTimestamp(_owner: string, _repo: string, _variant: ReleaseVariant, timestamp: number): Promise<void> {
    this.rpmTimestamp = timestamp;
  }

  async getRpmRepomd(_owner: string, _repo: string, _variant: ReleaseVariant): Promise<string | null> {
    return this.rpmMetadata.get('repomd') || null;
  }

  async setRpmRepomd(_owner: string, _repo: string, _variant: ReleaseVariant, content: string): Promise<void> {
    this.rpmMetadata.set('repomd', content);
  }

  async getRpmRepomdAsc(_owner: string, _repo: string, _variant: ReleaseVariant): Promise<string | null> {
    return this.rpmMetadata.get('repomd-asc') || null;
  }

  async setRpmRepomdAsc(_owner: string, _repo: string, _variant: ReleaseVariant, content: string): Promise<void> {
    this.rpmMetadata.set('repomd-asc', content);
  }

  async getAssetUrl(_owner: string, _repo: string, filename: string, _variant: ReleaseVariant, _releaseHash: string): Promise<string | null> {
    return this.assetUrls.get(filename) || null;
  }

  async setAssetUrl(_owner: string, _repo: string, filename: string, _variant: ReleaseVariant, _releaseHash: string, url: string): Promise<void> {
    this.assetUrls.set(filename, url);
  }

  async setAssetUrls(_owner: string, _repo: string, _variant: ReleaseVariant, _releaseHash: string, assets: Array<{ name: string; browser_download_url: string }>): Promise<void> {
    for (const asset of assets) {
      this.assetUrls.set(asset.name, asset.browser_download_url);
    }
  }

  async clearAllCache(_owner: string, _repo: string): Promise<void> {
    this.releaseIdsHash = null;
    this.inReleaseFile = null;
    this.releaseFile = null;
    this.releaseGpgSignature = null;
    this.packagesFiles.clear();
    this.rpmMetadata.clear();
    this.rpmTimestamp = null;
    this.assetUrls.clear();
  }

  // Reset call counts
  resetCalls(): void {
    for (const key of Object.keys(this.calls) as Array<keyof typeof this.calls>) {
      this.calls[key] = 0;
    }
  }
}

/**
 * Create a mock CacheManager instance
 */
export function createMockCacheManager(): MockCacheManager {
  return new MockCacheManager();
}
