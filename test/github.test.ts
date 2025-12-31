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

  describe('getLatestRelease', () => {
    it('fetches latest release successfully', async () => {
      const mockRelease = {
        id: 123,
        tag_name: 'v1.0.0',
        name: 'Version 1.0.0',
        body: 'Release notes',
        published_at: '2024-01-01T00:00:00Z',
        assets: [
          {
            id: 456,
            name: 'package_1.0.0_amd64.deb',
            size: 1000,
            browser_download_url: 'https://github.com/owner/repo/releases/download/v1.0.0/package_1.0.0_amd64.deb',
            content_type: 'application/vnd.debian.binary-package',
          },
        ],
      };

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockRelease),
      } as Response);

      const client = new GitHubClient();
      const release = await client.getLatestRelease('owner', 'repo');

      expect(release).toEqual(mockRelease);
      expect(fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/owner/repo/releases/latest',
        expect.objectContaining({
          headers: expect.objectContaining({
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'Reprox/1.0',
          }),
        })
      );
    });

    it('includes auth token when provided', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: 1, assets: [] }),
      } as Response);

      const client = new GitHubClient('test-token');
      await client.getLatestRelease('owner', 'repo');

      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'token test-token',
          }),
        })
      );
    });

    it('throws on 404 with descriptive message', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as Response);

      const client = new GitHubClient();

      await expect(client.getLatestRelease('owner', 'repo'))
        .rejects.toThrow('Repository owner/repo not found or has no releases');
    });

    it('throws on other HTTP errors', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response);

      const client = new GitHubClient();

      await expect(client.getLatestRelease('owner', 'repo'))
        .rejects.toThrow('GitHub API error: 500 Internal Server Error');
    });

    it('throws on rate limit error (403)', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      } as Response);

      const client = new GitHubClient();

      await expect(client.getLatestRelease('owner', 'repo'))
        .rejects.toThrow('GitHub API rate limit exceeded');
    });

    it('throws on rate limit error (429)', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      } as Response);

      const client = new GitHubClient();

      await expect(client.getLatestRelease('owner', 'repo'))
        .rejects.toThrow('GitHub API rate limit exceeded');
    });
  });
});
