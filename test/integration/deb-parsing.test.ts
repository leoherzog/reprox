import { it, expect } from 'vitest';
import {
  describeIntegration,
  TEST_REPOS,
  fetchPackageHeader,
  getLatestReleaseAssets,
  findDebAsset,
} from './setup';
import { parseDebBufferAsync } from '../../src/parsers/deb';

// =============================================================================
// Real .deb Parsing Integration Tests
// =============================================================================

describeIntegration('Real .deb Parsing', () => {
  // Generate tests dynamically from centralized config
  for (const repo of TEST_REPOS.filter(r => r.hasDeb)) {
    describeIntegration(`${repo.owner}/${repo.repo}`, () => {
      it('parses deb metadata correctly', async () => {
        // Fetch latest release assets
        const assets = await getLatestReleaseAssets(repo.owner, repo.repo);

        // Find an amd64 .deb file (handles amd64, x86_64, x86-64 patterns)
        const deb = findDebAsset(assets, 'amd64');
        if (!deb) {
          throw new Error(`No amd64 .deb found for ${repo.owner}/${repo.repo}`);
        }

        // Fetch first 256KB of the package (enough for control data)
        const buffer = await fetchPackageHeader(deb.browser_download_url);

        // Parse the .deb file
        const metadata = await parseDebBufferAsync(buffer);

        // Verify core metadata
        expect(metadata.package).toBe(repo.expectedPackageName);
        expect(metadata.version).toMatch(/^\d+\.\d+/);
        expect(metadata.architecture).toMatch(/amd64|x86_64|all/);
        expect(metadata.description).toBeTruthy();
      });

      it('has valid maintainer info', async () => {
        const assets = await getLatestReleaseAssets(repo.owner, repo.repo);
        const deb = findDebAsset(assets, 'amd64');

        if (!deb) {
          return; // Skip if no deb found
        }

        const buffer = await fetchPackageHeader(deb.browser_download_url);
        const metadata = await parseDebBufferAsync(buffer);

        // Maintainer should be present
        expect(metadata.maintainer).toBeTruthy();
      });
    });
  }
});

// =============================================================================
// Additional Architecture Tests
// =============================================================================

describeIntegration('Multi-architecture .deb Parsing', () => {
  // Test arm64 variants where available
  for (const repo of TEST_REPOS.filter(r => r.hasDeb)) {
    describeIntegration(`${repo.owner}/${repo.repo} arm64`, () => {
      it('parses arm64 deb if available', async () => {
        const assets = await getLatestReleaseAssets(repo.owner, repo.repo);

        // findDebAsset handles arm64, aarch64, arm-64 patterns
        const deb = findDebAsset(assets, 'arm64');

        if (!deb) {
          // Not all projects have arm64 builds - skip gracefully
          return;
        }

        const buffer = await fetchPackageHeader(deb.browser_download_url);
        const metadata = await parseDebBufferAsync(buffer);

        expect(metadata.package).toBe(repo.expectedPackageName);
        expect(metadata.architecture).toMatch(/arm64|aarch64|all/);
      });
    });
  }
});
