import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitHubClient, extractArchFromFilename, getArchitecturesFromAssets } from '../src/github/api';

// ============================================================================
// extractArchFromFilename Tests
// ============================================================================

describe('extractArchFromFilename', () => {
  describe('amd64 architecture', () => {
    it('detects amd64', () => {
      expect(extractArchFromFilename('package_1.0.0_amd64.deb')).toBe('amd64');
    });

    it('detects x86_64', () => {
      expect(extractArchFromFilename('package-1.0.0-1.x86_64.rpm')).toBe('amd64');
    });

    it('detects x64', () => {
      expect(extractArchFromFilename('package_x64.deb')).toBe('amd64');
    });

    it('is case insensitive', () => {
      expect(extractArchFromFilename('package_AMD64.deb')).toBe('amd64');
      expect(extractArchFromFilename('package_X86_64.rpm')).toBe('amd64');
    });
  });

  describe('arm64 architecture', () => {
    it('detects arm64', () => {
      expect(extractArchFromFilename('package_1.0.0_arm64.deb')).toBe('arm64');
    });

    it('detects aarch64', () => {
      expect(extractArchFromFilename('package-1.0.0-1.aarch64.rpm')).toBe('arm64');
    });
  });

  describe('i386 architecture', () => {
    it('detects i386', () => {
      expect(extractArchFromFilename('package_1.0.0_i386.deb')).toBe('i386');
    });

    it('detects i686', () => {
      expect(extractArchFromFilename('package-1.0.0-1.i686.rpm')).toBe('i386');
    });

    it('detects x86 but not x86_64', () => {
      expect(extractArchFromFilename('package_x86.deb')).toBe('i386');
      expect(extractArchFromFilename('package_x86_64.deb')).toBe('amd64'); // Not i386
    });
  });

  describe('armhf architecture', () => {
    it('detects armhf', () => {
      expect(extractArchFromFilename('package_1.0.0_armhf.deb')).toBe('armhf');
    });

    it('detects armv7', () => {
      expect(extractArchFromFilename('package-1.0.0-1.armv7.rpm')).toBe('armhf');
    });
  });

  describe('all architecture', () => {
    it('detects all', () => {
      expect(extractArchFromFilename('package_1.0.0_all.deb')).toBe('all');
    });
  });

  describe('default behavior', () => {
    it('defaults to amd64 when no pattern matches', () => {
      expect(extractArchFromFilename('package.deb')).toBe('amd64');
      expect(extractArchFromFilename('mystery-package-1.0.0.deb')).toBe('amd64');
    });
  });

  describe('real-world filenames', () => {
    it('handles go-hass-agent filenames', () => {
      expect(extractArchFromFilename('go-hass-agent_11.2.0_linux_amd64.deb')).toBe('amd64');
      expect(extractArchFromFilename('go-hass-agent_11.2.0_linux_arm64.deb')).toBe('arm64');
    });

    it('handles obsidian filenames', () => {
      expect(extractArchFromFilename('obsidian_1.5.12_amd64.deb')).toBe('amd64');
      expect(extractArchFromFilename('obsidian-1.5.12.x86_64.rpm')).toBe('amd64');
    });

    it('handles localsend filenames', () => {
      expect(extractArchFromFilename('LocalSend-1.14.0-linux-x86-64.deb')).toBe('amd64');
    });

    it('handles balena-etcher filenames', () => {
      expect(extractArchFromFilename('balena-etcher_1.18.11_amd64.deb')).toBe('amd64');
    });
  });
});

// ============================================================================
// getArchitecturesFromAssets Tests
// ============================================================================

describe('getArchitecturesFromAssets', () => {
  it('extracts architectures from deb files only', () => {
    const assets = [
      { name: 'package_1.0.0_amd64.deb' },
      { name: 'package_1.0.0_arm64.deb' },
      { name: 'package-1.0.0.tar.gz' }, // Should be ignored
      { name: 'package-1.0.0.x86_64.rpm' }, // Should be ignored (RPM)
    ];

    const archs = getArchitecturesFromAssets(assets);

    expect(archs).toContain('amd64');
    expect(archs).toContain('arm64');
    expect(archs).toContain('all'); // Always included
  });

  it('always includes all architecture', () => {
    const assets = [
      { name: 'package_1.0.0_amd64.deb' },
    ];

    const archs = getArchitecturesFromAssets(assets);

    expect(archs).toContain('all');
  });

  it('deduplicates architectures', () => {
    const assets = [
      { name: 'package1_1.0.0_amd64.deb' },
      { name: 'package2_1.0.0_amd64.deb' },
      { name: 'package3_1.0.0_amd64.deb' },
    ];

    const archs = getArchitecturesFromAssets(assets);
    const amd64Count = archs.filter(a => a === 'amd64').length;

    expect(amd64Count).toBe(1);
  });

  it('returns sorted architectures', () => {
    const assets = [
      { name: 'package_1.0.0_arm64.deb' },
      { name: 'package_1.0.0_amd64.deb' },
      { name: 'package_1.0.0_i386.deb' },
    ];

    const archs = getArchitecturesFromAssets(assets);

    // Should be sorted alphabetically
    expect(archs).toEqual(['all', 'amd64', 'arm64', 'i386']);
  });

  it('handles empty asset list', () => {
    const archs = getArchitecturesFromAssets([]);

    expect(archs).toEqual(['all']);
  });

  it('handles assets with no deb files', () => {
    const assets = [
      { name: 'package.tar.gz' },
      { name: 'package.x86_64.rpm' },
      { name: 'README.md' },
    ];

    const archs = getArchitecturesFromAssets(assets);

    expect(archs).toEqual(['all']);
  });
});

// ============================================================================
// GitHubClient Tests
// ============================================================================

describe('GitHubClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getAllReleases', () => {
    const createMockRelease = (id: number, prerelease: boolean = false) => ({
      id,
      tag_name: `v${id}.0.0`,
      name: `Version ${id}.0.0`,
      body: 'Release notes',
      published_at: '2024-01-01T00:00:00Z',
      prerelease,
      assets: [
        {
          id: id * 100,
          name: `package_${id}.0.0_amd64.deb`,
          size: 1000,
          browser_download_url: `https://github.com/owner/repo/releases/download/v${id}.0.0/package_${id}.0.0_amd64.deb`,
          content_type: 'application/vnd.debian.binary-package',
        },
      ],
    });

    it('fetches all releases from single page', async () => {
      const mockReleases = [createMockRelease(1), createMockRelease(2)];

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockReleases),
      } as Response);

      const client = new GitHubClient();
      const releases = await client.getAllReleases('owner', 'repo');

      expect(releases).toHaveLength(2);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/owner/repo/releases?per_page=100&page=1',
        expect.any(Object)
      );
    });

    it('paginates through multiple pages', async () => {
      // First page: 100 releases, second page: 50 releases
      const page1 = Array.from({ length: 100 }, (_, i) => createMockRelease(i + 1));
      const page2 = Array.from({ length: 50 }, (_, i) => createMockRelease(i + 101));

      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(page1),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(page2),
        } as Response);

      const client = new GitHubClient();
      const releases = await client.getAllReleases('owner', 'repo');

      expect(releases).toHaveLength(150);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenNthCalledWith(
        1,
        'https://api.github.com/repos/owner/repo/releases?per_page=100&page=1',
        expect.any(Object)
      );
      expect(fetch).toHaveBeenNthCalledWith(
        2,
        'https://api.github.com/repos/owner/repo/releases?per_page=100&page=2',
        expect.any(Object)
      );
    });

    it('stops pagination on empty page', async () => {
      const page1 = [createMockRelease(1)];

      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(page1),
        } as Response);

      const client = new GitHubClient();
      const releases = await client.getAllReleases('owner', 'repo');

      expect(releases).toHaveLength(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('filters out prereleases by default', async () => {
      const mockReleases = [
        createMockRelease(1, false),
        createMockRelease(2, true),  // prerelease
        createMockRelease(3, false),
        createMockRelease(4, true),  // prerelease
      ];

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockReleases),
      } as Response);

      const client = new GitHubClient();
      const releases = await client.getAllReleases('owner', 'repo');

      expect(releases).toHaveLength(2);
      expect(releases.every(r => !r.prerelease)).toBe(true);
    });

    it('includes prereleases when includePrerelease=true', async () => {
      const mockReleases = [
        createMockRelease(1, false),
        createMockRelease(2, true),
        createMockRelease(3, false),
        createMockRelease(4, true),
      ];

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockReleases),
      } as Response);

      const client = new GitHubClient();
      const releases = await client.getAllReleases('owner', 'repo', true);

      expect(releases).toHaveLength(4);
      expect(releases.filter(r => r.prerelease)).toHaveLength(2);
    });

    it('returns empty array when no releases exist', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      } as Response);

      const client = new GitHubClient();
      const releases = await client.getAllReleases('owner', 'repo');

      expect(releases).toEqual([]);
    });

    it('returns empty array when all releases are prereleases and filtering', async () => {
      const mockReleases = [
        createMockRelease(1, true),
        createMockRelease(2, true),
      ];

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockReleases),
      } as Response);

      const client = new GitHubClient();
      const releases = await client.getAllReleases('owner', 'repo', false);

      expect(releases).toEqual([]);
    });

    it('includes auth token when provided', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      } as Response);

      const client = new GitHubClient('test-token');
      await client.getAllReleases('owner', 'repo');

      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'token test-token',
          }),
        })
      );
    });

    it('throws on 404', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as Response);

      const client = new GitHubClient();

      await expect(client.getAllReleases('owner', 'repo'))
        .rejects.toThrow('Repository owner/repo not found or has no releases');
    });

    it('throws on rate limit error (403)', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      } as Response);

      const client = new GitHubClient();

      await expect(client.getAllReleases('owner', 'repo'))
        .rejects.toThrow('GitHub API rate limit exceeded');
    });

    it('throws on rate limit error (429)', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      } as Response);

      const client = new GitHubClient();

      await expect(client.getAllReleases('owner', 'repo'))
        .rejects.toThrow('GitHub API rate limit exceeded');
    });

    it('throws on other HTTP errors', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response);

      const client = new GitHubClient();

      await expect(client.getAllReleases('owner', 'repo'))
        .rejects.toThrow('GitHub API error: 500 Internal Server Error');
    });

    it('respects max page limit to prevent infinite loops', async () => {
      // Always return exactly 100 items to simulate infinite pagination
      const fullPage = Array.from({ length: 100 }, (_, i) => createMockRelease(i + 1));

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(fullPage),
      } as Response);

      const client = new GitHubClient();
      const releases = await client.getAllReleases('owner', 'repo');

      // Should stop at MAX_PAGES (50) * 100 = 5000 releases
      expect(fetch).toHaveBeenCalledTimes(50);
      expect(releases).toHaveLength(5000);
    });
  });
});
