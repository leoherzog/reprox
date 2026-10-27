/**
 * Range requests for the package headers at the start of GitHub release assets.
 */

import { githubHeaders } from '../github/api';

/**
 * Thrown when a header range request fails at the network or HTTP level.
 * The failure says nothing about the package, so callers must retry or
 * abort rather than drop the package.
 */
export class HeaderFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeaderFetchError';
  }
}

/**
 * Fetch the first `size` bytes of a release asset.
 * @throws HeaderFetchError on a network error or a non-2xx status
 */
export async function fetchRange(url: string, size: number, githubToken?: string): Promise<ArrayBuffer> {
  try {
    const response = await fetch(url, {
      headers: { ...githubHeaders(githubToken, 'octet-stream'), Range: `bytes=0-${size - 1}` },
    });
    if (!response.ok) {
      throw new HeaderFetchError(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }
    return await response.arrayBuffer();
  } catch (error) {
    if (error instanceof HeaderFetchError) throw error;
    throw new HeaderFetchError(`Failed to fetch ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
