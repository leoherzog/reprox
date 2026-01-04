import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../src/types';

// Import the default export which contains the fetch handler
import worker from '../src/index';

// ============================================================================
// Test Helpers
// ============================================================================

function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    GPG_PRIVATE_KEY: undefined,
    GPG_PUBLIC_KEY: undefined,
    GITHUB_TOKEN: undefined,
    CACHE_TTL: undefined,
    ...overrides,
  };
}

interface MockExecutionContext extends ExecutionContext {
  waitUntilPromises: Promise<unknown>[];
  flushWaitUntil: () => Promise<void>;
}

function createMockExecutionContext(): MockExecutionContext {
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
// Root Path Handler Tests
// ============================================================================

describe('root path handler', () => {
  it('returns usage instructions at root path (markdown for non-browser)', async () => {
    const env = createMockEnv();
    const ctx = createMockExecutionContext();
    const request = new Request('https://example.com/');

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('Reprox');
    expect(text).toContain('APT');
    expect(text).toContain('RPM');
  });

  it('returns HTML for browser requests', async () => {
    const env = createMockEnv();
    const ctx = createMockExecutionContext();
    const request = new Request('https://example.com/', {
      headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9' },
    });

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    const text = await response.text();
    expect(text).toContain('<!DOCTYPE html>');
    expect(text).toContain('Reprox');
  });

  it('uses dynamic URL based on incoming request (markdown)', async () => {
    const env = createMockEnv();
    const ctx = createMockExecutionContext();
    const request = new Request('https://custom.domain.com/');

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    const text = await response.text();
    // URLs should be replaced with the custom domain
    expect(text).toContain('https://custom.domain.com/{owner}/{repo}');
    // Should not contain reprox.dev URLs (prose mentions of reprox.dev are fine)
    expect(text).not.toContain('https://reprox.dev');
  });

  it('uses dynamic URL based on incoming request (HTML)', async () => {
    const env = createMockEnv();
    const ctx = createMockExecutionContext();
    const request = new Request('https://custom.domain.com/', {
      headers: { 'Accept': 'text/html' },
    });

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    const text = await response.text();
    // URLs should be replaced with the custom domain
    expect(text).toContain('https://custom.domain.com/{owner}/{repo}');
    // Should not contain reprox.dev URLs (prose mentions of reprox.dev are fine)
    expect(text).not.toContain('https://reprox.dev');
  });

  it('returns markdown content type for non-browser requests', async () => {
    const env = createMockEnv();
    const ctx = createMockExecutionContext();
    const request = new Request('https://example.com/');

    const response = await worker.fetch(request, env, ctx);

    expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
  });
});

// ============================================================================
// Public Key Handler Tests
// ============================================================================

describe('handlePublicKey', () => {
  it('returns GPG_PUBLIC_KEY when configured', async () => {
    const publicKey = '-----BEGIN PGP PUBLIC KEY BLOCK-----\ntest-key\n-----END PGP PUBLIC KEY BLOCK-----';
    const env = createMockEnv({ GPG_PUBLIC_KEY: publicKey });
    const ctx = createMockExecutionContext();
    const request = new Request('https://example.com/owner/repo/public.key');

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/pgp-keys');
    expect(await response.text()).toBe(publicKey);
  });

  it('returns 404 when no GPG key configured', async () => {
    const env = createMockEnv();
    const ctx = createMockExecutionContext();
    const request = new Request('https://example.com/owner/repo/public.key');

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(404);
    expect(await response.text()).toContain('No GPG key configured');
  });

  it('includes Cache-Control header for public key', async () => {
    const publicKey = '-----BEGIN PGP PUBLIC KEY BLOCK-----\ntest\n-----END PGP PUBLIC KEY BLOCK-----';
    const env = createMockEnv({ GPG_PUBLIC_KEY: publicKey });
    const ctx = createMockExecutionContext();
    const request = new Request('https://example.com/owner/repo/public.key');

    const response = await worker.fetch(request, env, ctx);

    expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400');
  });
});

// ============================================================================
// Route Validation Tests
// ============================================================================

describe('route validation', () => {
  const ctx = createMockExecutionContext();

  it('rejects invalid owner with too long name', async () => {
    const env = createMockEnv();
    const longOwner = 'a'.repeat(50); // GitHub max is 39
    const request = new Request(`https://example.com/${longOwner}/repo/public.key`);

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Invalid owner name');
  });

  it('rejects invalid owner with special characters', async () => {
    const env = createMockEnv();
    const request = new Request('https://example.com/owner@invalid/repo/public.key');

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Invalid owner name');
  });

  it('rejects owner starting with special characters', async () => {
    const env = createMockEnv();
    const request = new Request('https://example.com/-invalid/repo/public.key');

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Invalid owner name');
  });

  it('rejects invalid repo with too long name', async () => {
    const env = createMockEnv();
    const longRepo = 'a'.repeat(150); // GitHub max is 100
    const request = new Request(`https://example.com/owner/${longRepo}/public.key`);

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Invalid repository name');
  });

  it('rejects repo with invalid characters', async () => {
    const env = createMockEnv();
    const request = new Request('https://example.com/owner/repo$invalid/public.key');

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Invalid repository name');
  });

  it('accepts valid GitHub naming patterns', async () => {
    const env = createMockEnv({ GPG_PUBLIC_KEY: 'test-key' });

    const validPaths = [
      '/valid-owner/valid-repo/public.key',
      '/owner123/repo_name/public.key',
      '/Owner/Repo.Name/public.key',
      '/a/b/public.key', // Minimum length
    ];

    for (const path of validPaths) {
      const request = new Request(`https://example.com${path}`);
      const response = await worker.fetch(request, env, ctx);
      // Should not be 400 for valid names
      expect(response.status).not.toBe(400);
    }
  });

  it('returns 400 for missing owner/repo', async () => {
    const env = createMockEnv();
    const request = new Request('https://example.com/onlyowner');

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Invalid repository path');
  });
});

// ============================================================================
// By-Hash Handler Tests (Mock GitHub API)
// ============================================================================

describe('handleByHash', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns 404 for unsupported hash type MD5', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();

    // Mock GitHub API responses
    vi.mocked(fetch).mockImplementation(async (url) => {
      const urlStr = url.toString();
      if (urlStr.includes('api.github.com')) {
        return new Response(JSON.stringify({
          id: 123,
          tag_name: 'v1.0.0',
          name: 'Release 1.0.0',
          body: '',
          published_at: '2024-01-01T00:00:00Z',
          assets: [],
        }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    });

    const request = new Request(
      'https://example.com/owner/repo/dists/stable/main/binary-amd64/by-hash/MD5/abc123'
    );
    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(404);
    expect(await response.text()).toContain('Unsupported hash type: MD5');
  });

  it('returns 400 for invalid by-hash request', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();

    // Mock GitHub API
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({
        id: 123,
        tag_name: 'v1.0.0',
        name: 'Release',
        body: '',
        published_at: '2024-01-01T00:00:00Z',
        assets: [],
      }), { status: 200 })
    );

    // Request with missing hash value (malformed by-hash request)
    const request = new Request(
      'https://example.com/owner/repo/dists/stable/main/binary-amd64/by-hash/SHA256/'
    );
    const response = await worker.fetch(request, env, ctx);

    // The route parser should handle this as unknown or the handler returns 400
    expect([400, 404]).toContain(response.status);
  });
});

// ============================================================================
// Unknown Route Handler Tests
// ============================================================================

describe('unknown routes', () => {
  it('returns 404 for unknown route type', async () => {
    const env = createMockEnv({ GITHUB_TOKEN: 'test-token' });
    const ctx = createMockExecutionContext();

    // Mock GitHub API
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        id: 123,
        tag_name: 'v1.0.0',
        name: 'Release',
        body: '',
        published_at: '2024-01-01T00:00:00Z',
        assets: [],
      }), { status: 200 })
    ));

    const request = new Request('https://example.com/owner/repo/unknown/path');
    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(404);
  });
});
