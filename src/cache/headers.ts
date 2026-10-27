/**
 * Global store of parsed package headers in Workers KV, shared by every colo.
 * A value is a pure function of the asset bytes and is keyed by their SHA256,
 * so it never goes stale and only headers no colo has parsed are fetched.
 */

import type { GitHubAsset } from '../types';
import { mapWithConcurrency } from '../utils/concurrency';
import { HeaderFetchError } from '../utils/fetch';

// Bump a version to invalidate its stored headers after a parser change.
const KEY_PREFIXES = { rpm: 'rpm/v1', deb: 'deb/v1' } as const;

// Below the 100-key bulk get maximum, so a batch that fails costs fewer single gets.
const KV_GET_BATCH = 25;
const FETCH_ATTEMPTS = 3;
const FETCH_BACKOFF_MS = 250;

/**
 * Thrown when a package header could not be fetched. Metadata built without
 * that package would differ from metadata built elsewhere for the same
 * releases, and a signature over it would not verify against theirs.
 */
export class IncompleteSnapshotError extends Error {
  constructor(failed: string[]) {
    super(`Could not fetch package headers for: ${failed.join(', ')}`);
    this.name = 'IncompleteSnapshotError';
  }
}

/**
 * Read one batch of stored headers. A bulk get fails with 413 past 25 MB of
 * values, which large RPM headers reach, so a failed batch falls back to one
 * get per key.
 * @returns values by key; null for a miss or a key whose own get failed
 */
async function readBatch<T>(kv: KVNamespace, keys: string[]): Promise<Map<string, T | null>> {
  try {
    return await kv.get<T>(keys, 'json');
  } catch {
    const values = await Promise.all(keys.map(key => kv.get<T>(key, 'json').catch(error => {
      console.error(`Header store read failed for ${key}:`, error);
      return null;
    })));
    return new Map(keys.map((key, i) => [key, values[i]]));
  }
}

/**
 * Fetch one header, retrying fetch failures with backoff.
 * @returns the header, or null when the package itself is unusable
 * @throws HeaderFetchError when every attempt failed to fetch
 */
async function fetchWithRetry<T>(
  asset: GitHubAsset,
  fetchHeader: (url: string) => Promise<T | null>
): Promise<T | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchHeader(asset.browser_download_url);
    } catch (error) {
      if (!(error instanceof HeaderFetchError)) {
        console.error(`Failed to process ${asset.name}:`, error);
        return null;
      }
      if (attempt === FETCH_ATTEMPTS) throw error;
      await new Promise(resolve => setTimeout(resolve, FETCH_BACKOFF_MS * 2 ** (attempt - 1)));
    }
  }
}

/**
 * Resolve the parsed header of each asset: read the store, then fetch the
 * misses and store each successful parse. Assets must have sha256 digests.
 * @param fetchHeader returns null for an unusable package and throws
 *   HeaderFetchError when the fetch failed
 * @returns headers by asset; unusable packages are absent
 * @throws IncompleteSnapshotError when any header fetch failed
 */
export async function loadHeaders<T>(
  kv: KVNamespace,
  kind: keyof typeof KEY_PREFIXES,
  assets: GitHubAsset[],
  fetchHeader: (url: string) => Promise<T | null>
): Promise<Map<GitHubAsset, T>> {
  const keyOf = (asset: GitHubAsset) => `${KEY_PREFIXES[kind]}/${asset.digest!.slice(7)}`;
  const assetsByKey = new Map(assets.map(asset => [keyOf(asset), asset]));
  const keys = [...assetsByKey.keys()];

  // Default cacheTtl: KV caches misses too, so a longer one would hide
  // headers that another colo has just stored.
  const batches: Promise<Map<string, T | null>>[] = [];
  for (let i = 0; i < keys.length; i += KV_GET_BATCH) {
    batches.push(readBatch<T>(kv, keys.slice(i, i + KV_GET_BATCH)));
  }
  const headers = new Map<string, T>();
  for (const batch of await Promise.all(batches)) {
    for (const [key, header] of batch) {
      if (header !== null) headers.set(key, header);
    }
  }

  const failed: string[] = [];
  const misses = keys.filter(key => !headers.has(key));
  await mapWithConcurrency(misses, async (key) => {
    const asset = assetsByKey.get(key)!;
    let header: T | null;
    try {
      header = await fetchWithRetry(asset, fetchHeader);
    } catch (error) {
      console.error(`Failed to fetch ${asset.name}:`, error);
      failed.push(asset.name);
      return;
    }
    if (header === null) return;
    headers.set(key, header);
    await kv.put(key, JSON.stringify(header)).catch(error => console.error(`Failed to store ${key}:`, error));
  });

  if (failed.length > 0) throw new IncompleteSnapshotError(failed);

  const result = new Map<GitHubAsset, T>();
  for (const asset of assets) {
    const header = headers.get(keyOf(asset));
    if (header !== undefined) result.set(asset, header);
  }
  return result;
}
