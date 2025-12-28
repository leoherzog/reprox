import { it, expect } from 'vitest';
import {
  describeIntegration,
  TEST_REPOS,
  GITHUB_TOKEN,
  getLatestReleaseAssets,
  findRpmAsset,
} from './setup';
import { extractRpmMetadata } from '../../src/parsers/rpm';

// =============================================================================
// Real .rpm Parsing Integration Tests
// =============================================================================

describeIntegration('Real .rpm Parsing', () => {
  // Generate tests dynamically from centralized config
  for (const repo of TEST_REPOS.filter(r => r.hasRpm)) {
    describeIntegration(`${repo.owner}/${repo.repo}`, () => {
      it('parses rpm metadata correctly', async () => {
        // Fetch latest release assets
        const assets = await getLatestReleaseAssets(repo.owner, repo.repo);

        // Find an x86_64 .rpm file
        const rpm = findRpmAsset(assets, 'x86_64');
        if (!rpm) {
          throw new Error(`No x86_64 .rpm found for ${repo.owner}/${repo.repo}`);
        }

        // extractRpmMetadata already uses Range requests internally
        const metadata = await extractRpmMetadata(
          rpm.browser_download_url,
          GITHUB_TOKEN
        );

        // Verify core metadata
        expect(metadata.name).toBe(repo.expectedPackageName);
        expect(metadata.version).toMatch(/^\d+\.\d+/);
        expect(metadata.arch).toBe('x86_64');
        expect(metadata.summary).toBeTruthy();
      });

      it('has valid vendor or packager info', async () => {
        const assets = await getLatestReleaseAssets(repo.owner, repo.repo);
        const rpm = findRpmAsset(assets, 'x86_64');

        if (!rpm) {
          return; // Skip if no rpm found
        }

        const metadata = await extractRpmMetadata(
          rpm.browser_download_url,
          GITHUB_TOKEN
        );

        // At least one of vendor or packager should be present
        const hasVendorInfo = metadata.vendor || metadata.packager;
        expect(hasVendorInfo).toBeTruthy();
      });

      it('has valid license information', async () => {
        const assets = await getLatestReleaseAssets(repo.owner, repo.repo);
        const rpm = findRpmAsset(assets, 'x86_64');

        if (!rpm) {
          return;
        }

        const metadata = await extractRpmMetadata(
          rpm.browser_download_url,
          GITHUB_TOKEN
        );

        // License should be present
        expect(metadata.license).toBeTruthy();
      });
    });
  }
});

// =============================================================================
// Additional Architecture Tests
// =============================================================================

describeIntegration('Multi-architecture .rpm Parsing', () => {
  // Test aarch64 variants where available
  for (const repo of TEST_REPOS.filter(r => r.hasRpm)) {
    describeIntegration(`${repo.owner}/${repo.repo} aarch64`, () => {
      it('parses aarch64 rpm if available', async () => {
        const assets = await getLatestReleaseAssets(repo.owner, repo.repo);

        // Try aarch64 or arm64
        const rpm = findRpmAsset(assets, 'aarch64') || findRpmAsset(assets, 'arm64');

        if (!rpm) {
          // Not all projects have aarch64 builds - skip gracefully
          return;
        }

        const metadata = await extractRpmMetadata(
          rpm.browser_download_url,
          GITHUB_TOKEN
        );

        expect(metadata.name).toBe(repo.expectedPackageName);
        expect(metadata.arch).toMatch(/aarch64|arm64/);
      });
    });
  }
});

// =============================================================================
// RPM-Specific Field Tests
// =============================================================================

describeIntegration('RPM Field Extraction', () => {
  // Pick one known repo to test detailed field extraction
  const testRepo = TEST_REPOS.find(r => r.hasRpm && r.repo === 'go-hass-agent');

  if (testRepo) {
    describeIntegration('go-hass-agent detailed fields', () => {
      it('extracts file list', async () => {
        const assets = await getLatestReleaseAssets(testRepo.owner, testRepo.repo);
        const rpm = findRpmAsset(assets, 'x86_64');

        if (!rpm) return;

        const metadata = await extractRpmMetadata(
          rpm.browser_download_url,
          GITHUB_TOKEN
        );

        // Should have some files listed
        expect(metadata.files).toBeInstanceOf(Array);
        // Most packages have at least a few files
        expect(metadata.files.length).toBeGreaterThan(0);
      });

      it('extracts dependencies', async () => {
        const assets = await getLatestReleaseAssets(testRepo.owner, testRepo.repo);
        const rpm = findRpmAsset(assets, 'x86_64');

        if (!rpm) return;

        const metadata = await extractRpmMetadata(
          rpm.browser_download_url,
          GITHUB_TOKEN
        );

        // Requires and provides should be arrays (may be empty)
        expect(metadata.requires).toBeInstanceOf(Array);
        expect(metadata.provides).toBeInstanceOf(Array);
      });
    });
  }
});
