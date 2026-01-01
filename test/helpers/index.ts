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
 * Create a mock ExecutionContext for Cloudflare Workers
 */
export function createMockExecutionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
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
