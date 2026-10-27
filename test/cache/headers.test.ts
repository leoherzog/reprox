/**
 * Tests for the global parsed-header store (src/cache/headers.ts).
 * KV storage is shared between tests in this file, so each test uses its own digests.
 */

import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { loadHeaders, IncompleteSnapshotError } from '../../src/cache/headers';
import { HeaderFetchError } from '../../src/utils/fetch';
import type { Env, GitHubAsset } from '../../src/types';

const kv = (env as Env).ENTRIES;

function asset(name: string, digestChar: string): GitHubAsset {
  return {
    id: 1,
    name,
    size: 100,
    browser_download_url: `https://github.com/o/r/releases/download/v1/${name}`,
    digest: `sha256:${digestChar.repeat(64)}`,
  };
}

describe('loadHeaders', () => {
  it('serves a stored header without fetching', async () => {
    const a = asset('hit.rpm', '1');
    await kv.put(`rpm/v1/${'1'.repeat(64)}`, JSON.stringify({ name: 'stored' }));
    const fetchHeader = vi.fn();

    const headers = await loadHeaders(kv, 'rpm', [a], fetchHeader);

    expect(fetchHeader).not.toHaveBeenCalled();
    expect(headers.get(a)).toEqual({ name: 'stored' });
  });

  it('fetches a miss and stores it under its kind, version and digest', async () => {
    const a = asset('miss.deb', '2');
    const fetchHeader = vi.fn(async () => ({ package: 'fresh' }));

    const headers = await loadHeaders(kv, 'deb', [a], fetchHeader);

    expect(fetchHeader).toHaveBeenCalledWith(a.browser_download_url);
    expect(headers.get(a)).toEqual({ package: 'fresh' });
    expect(await kv.get(`deb/v1/${'2'.repeat(64)}`, 'json')).toEqual({ package: 'fresh' });
    expect(await kv.get(`rpm/v1/${'2'.repeat(64)}`)).toBeNull();
  });

  it('throws IncompleteSnapshotError on a fetch failure and stores only what succeeded', async () => {
    const failing = asset('down.rpm', '3');
    const working = asset('up.rpm', '4');
    const fetchHeader = vi.fn(async (url: string) => {
      if (url === failing.browser_download_url) throw new HeaderFetchError('429 Too Many Requests');
      return { name: 'up' };
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(loadHeaders(kv, 'rpm', [failing, working], fetchHeader))
      .rejects.toThrow(IncompleteSnapshotError);

    expect(fetchHeader).toHaveBeenCalledTimes(4); // three attempts, plus one for the working asset
    expect(await kv.get(`rpm/v1/${'3'.repeat(64)}`)).toBeNull();
    expect(await kv.get(`rpm/v1/${'4'.repeat(64)}`, 'json')).toEqual({ name: 'up' });
    vi.restoreAllMocks();
  });

  it('drops an unparseable or unusable package without storing it', async () => {
    const garbage = asset('garbage.rpm', '5');
    const oversized = asset('oversized.rpm', '6');
    const fetchHeader = vi.fn(async (url: string) => {
      if (url === garbage.browser_download_url) throw new Error('Invalid RPM file: bad magic');
      return null;
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const headers = await loadHeaders(kv, 'rpm', [garbage, oversized], fetchHeader);

    expect(headers.size).toBe(0);
    expect(fetchHeader).toHaveBeenCalledTimes(2); // parse failures are not retried
    expect(await kv.get(`rpm/v1/${'5'.repeat(64)}`)).toBeNull();
    expect(await kv.get(`rpm/v1/${'6'.repeat(64)}`)).toBeNull();
    vi.restoreAllMocks();
  });

  it('stores a header to expire after a year plus up to a month', async () => {
    const a = asset('expiring.deb', '9');
    const now = Date.now() / 1000;

    await loadHeaders(kv, 'deb', [a], async () => ({ package: 'expiring' }));

    const { keys: [stored] } = await kv.list({ prefix: `deb/v1/${'9'.repeat(64)}` });
    expect(stored.expiration).toBeGreaterThanOrEqual(Math.floor(now) + 365 * 86400);
    expect(stored.expiration).toBeLessThanOrEqual(Math.ceil(now) + 395 * 86400);
  });

  it('fetches assets that share a digest once', async () => {
    const a = asset('same_amd64.deb', '7');
    const b = asset('same-renamed_amd64.deb', '7');
    const fetchHeader = vi.fn(async () => ({ package: 'same' }));

    const headers = await loadHeaders(kv, 'deb', [a, b], fetchHeader);

    expect(fetchHeader).toHaveBeenCalledTimes(1);
    expect(headers.get(a)).toEqual({ package: 'same' });
    expect(headers.get(b)).toEqual({ package: 'same' });
  });

  it('reads a batch one key at a time when its bulk get fails', async () => {
    const a = asset('large.rpm', '8');
    await kv.put(`rpm/v1/${'8'.repeat(64)}`, JSON.stringify({ name: 'large' }));
    // A bulk get over the 25 MB response limit fails with 413.
    const oversizedBulk = {
      get: (key: string | string[], type: 'json') =>
        Array.isArray(key) ? Promise.reject(new Error('KV GET failed: 413 Payload Too Large')) : kv.get(key, type),
      put: kv.put.bind(kv),
    } as unknown as KVNamespace;
    const fetchHeader = vi.fn();

    const headers = await loadHeaders(oversizedBulk, 'rpm', [a], fetchHeader);

    expect(fetchHeader).not.toHaveBeenCalled();
    expect(headers.get(a)).toEqual({ name: 'large' });
  });

  it('reads more stored headers than fit in one bulk get', async () => {
    const assets = Array.from({ length: 60 }, (_, i) => ({
      ...asset(`bulk-${i}.rpm`, 'e'),
      digest: `sha256:${i.toString(16).padStart(64, 'b')}`,
    }));
    await Promise.all(assets.map((a, i) => kv.put(`rpm/v1/${a.digest!.slice(7)}`, JSON.stringify({ i }))));
    const fetchHeader = vi.fn();

    const headers = await loadHeaders(kv, 'rpm', assets, fetchHeader);

    expect(fetchHeader).not.toHaveBeenCalled();
    expect(assets.map(a => headers.get(a))).toEqual(assets.map((_, i) => ({ i })));
  });
});
