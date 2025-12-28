import { describe, it, expect } from 'vitest';
import { parseRoute } from '../src/index';

describe('parseRoute', () => {
  // ============================================================================
  // Basic Route Parsing
  // ============================================================================

  describe('basic parsing', () => {
    it('extracts owner and repo from path', () => {
      const route = parseRoute('/owner/repo/some/path');
      expect(route.owner).toBe('owner');
      expect(route.repo).toBe('repo');
    });

    it('handles empty path', () => {
      const route = parseRoute('/');
      expect(route.owner).toBe('');
      expect(route.repo).toBe('');
      expect(route.type).toBe('unknown');
    });

    it('handles path with only owner', () => {
      const route = parseRoute('/owner');
      expect(route.owner).toBe('owner');
      expect(route.repo).toBe('');
    });

    it('returns unknown type for unrecognized paths', () => {
      const route = parseRoute('/owner/repo/unknown/path');
      expect(route.type).toBe('unknown');
    });

    it('sets default values', () => {
      const route = parseRoute('/owner/repo/unknown');
      expect(route.distribution).toBe('stable');
      expect(route.component).toBe('main');
      expect(route.architecture).toBe('amd64');
      expect(route.filename).toBe('');
    });
  });

  // ============================================================================
  // Public Key Route
  // ============================================================================

  describe('public-key route', () => {
    it('matches /{owner}/{repo}/public.key', () => {
      const route = parseRoute('/joshuar/go-hass-agent/public.key');
      expect(route.type).toBe('public-key');
      expect(route.owner).toBe('joshuar');
      expect(route.repo).toBe('go-hass-agent');
    });
  });

  // ============================================================================
  // APT Routes - dists
  // ============================================================================

  describe('APT dists routes', () => {
    it('matches InRelease', () => {
      const route = parseRoute('/owner/repo/dists/stable/InRelease');
      expect(route.type).toBe('inrelease');
      expect(route.distribution).toBe('stable');
    });

    it('matches Release', () => {
      const route = parseRoute('/owner/repo/dists/focal/Release');
      expect(route.type).toBe('release');
      expect(route.distribution).toBe('focal');
    });

    it('matches Release.gpg', () => {
      const route = parseRoute('/owner/repo/dists/jammy/Release.gpg');
      expect(route.type).toBe('release-gpg');
      expect(route.distribution).toBe('jammy');
    });

    it('matches Packages', () => {
      const route = parseRoute('/owner/repo/dists/stable/main/binary-amd64/Packages');
      expect(route.type).toBe('packages');
      expect(route.distribution).toBe('stable');
      expect(route.component).toBe('main');
      expect(route.architecture).toBe('amd64');
    });

    it('matches Packages.gz', () => {
      const route = parseRoute('/owner/repo/dists/stable/main/binary-arm64/Packages.gz');
      expect(route.type).toBe('packages-gz');
      expect(route.architecture).toBe('arm64');
    });

    it('handles different architectures', () => {
      const archs = ['amd64', 'arm64', 'i386', 'armhf', 'all'];
      for (const arch of archs) {
        const route = parseRoute(`/owner/repo/dists/stable/main/binary-${arch}/Packages`);
        expect(route.architecture).toBe(arch);
      }
    });

    it('handles different components', () => {
      const route = parseRoute('/owner/repo/dists/stable/contrib/binary-amd64/Packages');
      expect(route.component).toBe('contrib');
    });

    it('handles different distributions', () => {
      const dists = ['stable', 'unstable', 'testing', 'bookworm', 'bullseye'];
      for (const dist of dists) {
        const route = parseRoute(`/owner/repo/dists/${dist}/InRelease`);
        expect(route.distribution).toBe(dist);
      }
    });
  });

  // ============================================================================
  // APT Routes - by-hash
  // ============================================================================

  describe('APT by-hash routes', () => {
    it('matches by-hash with SHA256', () => {
      const hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
      const route = parseRoute(`/owner/repo/dists/stable/main/binary-amd64/by-hash/SHA256/${hash}`);
      expect(route.type).toBe('by-hash');
      expect(route.hashType).toBe('SHA256');
      expect(route.hash).toBe(hash);
    });

    it('matches by-hash with SHA512', () => {
      const hash = 'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e';
      const route = parseRoute(`/owner/repo/dists/stable/main/binary-amd64/by-hash/SHA512/${hash}`);
      expect(route.type).toBe('by-hash');
      expect(route.hashType).toBe('SHA512');
      expect(route.hash).toBe(hash);
    });

    it('preserves component and architecture in by-hash', () => {
      const route = parseRoute('/owner/repo/dists/focal/contrib/binary-arm64/by-hash/SHA256/abc123');
      expect(route.component).toBe('contrib');
      expect(route.architecture).toBe('arm64');
      expect(route.distribution).toBe('focal');
    });
  });

  // ============================================================================
  // APT Routes - pool (binary downloads)
  // ============================================================================

  describe('APT pool routes', () => {
    it('matches .deb file in pool', () => {
      const route = parseRoute('/owner/repo/pool/main/h/hello/hello_1.0.0_amd64.deb');
      expect(route.type).toBe('binary');
      expect(route.filename).toBe('hello_1.0.0_amd64.deb');
    });

    it('handles deep pool paths', () => {
      const route = parseRoute('/owner/repo/pool/main/libf/libfoo/libfoo1_2.3.4-5_arm64.deb');
      expect(route.type).toBe('binary');
      expect(route.filename).toBe('libfoo1_2.3.4-5_arm64.deb');
    });

    it('handles packages with underscores and hyphens', () => {
      const route = parseRoute('/owner/repo/pool/main/g/go-hass-agent/go-hass-agent_1.2.3-4_amd64.deb');
      expect(route.type).toBe('binary');
      expect(route.filename).toBe('go-hass-agent_1.2.3-4_amd64.deb');
    });

    it('does not match non-.deb files in pool', () => {
      const route = parseRoute('/owner/repo/pool/main/h/hello/hello_1.0.0_amd64.tar.gz');
      expect(route.type).toBe('unknown');
    });
  });

  // ============================================================================
  // RPM Routes - repodata
  // ============================================================================

  describe('RPM repodata routes', () => {
    it('matches repomd.xml', () => {
      const route = parseRoute('/owner/repo/repodata/repomd.xml');
      expect(route.type).toBe('repomd');
    });

    it('matches repomd.xml.asc', () => {
      const route = parseRoute('/owner/repo/repodata/repomd.xml.asc');
      expect(route.type).toBe('repomd-asc');
    });

    it('matches primary.xml', () => {
      const route = parseRoute('/owner/repo/repodata/primary.xml');
      expect(route.type).toBe('primary');
    });

    it('matches primary.xml.gz', () => {
      const route = parseRoute('/owner/repo/repodata/primary.xml.gz');
      expect(route.type).toBe('primary-gz');
    });

    it('matches filelists.xml', () => {
      const route = parseRoute('/owner/repo/repodata/filelists.xml');
      expect(route.type).toBe('filelists');
    });

    it('matches filelists.xml.gz', () => {
      const route = parseRoute('/owner/repo/repodata/filelists.xml.gz');
      expect(route.type).toBe('filelists-gz');
    });

    it('matches other.xml', () => {
      const route = parseRoute('/owner/repo/repodata/other.xml');
      expect(route.type).toBe('other');
    });

    it('matches other.xml.gz', () => {
      const route = parseRoute('/owner/repo/repodata/other.xml.gz');
      expect(route.type).toBe('other-gz');
    });

    it('returns unknown for other repodata files', () => {
      const route = parseRoute('/owner/repo/repodata/unknown.xml');
      expect(route.type).toBe('unknown');
    });
  });

  // ============================================================================
  // RPM Routes - Packages (binary downloads)
  // ============================================================================

  describe('RPM Packages routes', () => {
    it('matches .rpm file in Packages', () => {
      const route = parseRoute('/owner/repo/Packages/hello-1.0.0-1.x86_64.rpm');
      expect(route.type).toBe('rpm-binary');
      expect(route.filename).toBe('hello-1.0.0-1.x86_64.rpm');
    });

    it('handles complex RPM filenames', () => {
      const route = parseRoute('/owner/repo/Packages/go-hass-agent-1.2.3-4.fc38.x86_64.rpm');
      expect(route.type).toBe('rpm-binary');
      expect(route.filename).toBe('go-hass-agent-1.2.3-4.fc38.x86_64.rpm');
    });

    it('does not match non-.rpm files', () => {
      const route = parseRoute('/owner/repo/Packages/hello-1.0.0.tar.gz');
      expect(route.type).toBe('unknown');
    });
  });

  // ============================================================================
  // Real-world Examples
  // ============================================================================

  describe('real-world examples', () => {
    it('parses go-hass-agent APT request', () => {
      const route = parseRoute('/joshuar/go-hass-agent/dists/stable/main/binary-amd64/Packages');
      expect(route.owner).toBe('joshuar');
      expect(route.repo).toBe('go-hass-agent');
      expect(route.type).toBe('packages');
    });

    it('parses obsidian InRelease request', () => {
      const route = parseRoute('/obsidianmd/obsidian-releases/dists/stable/InRelease');
      expect(route.owner).toBe('obsidianmd');
      expect(route.repo).toBe('obsidian-releases');
      expect(route.type).toBe('inrelease');
    });

    it('parses localsend RPM request', () => {
      const route = parseRoute('/localsend/localsend/repodata/primary.xml.gz');
      expect(route.owner).toBe('localsend');
      expect(route.repo).toBe('localsend');
      expect(route.type).toBe('primary-gz');
    });

    it('parses balena-etcher deb download', () => {
      const route = parseRoute('/balena-io/etcher/pool/main/b/balena-etcher/balena-etcher_1.18.11_amd64.deb');
      expect(route.owner).toBe('balena-io');
      expect(route.repo).toBe('etcher');
      expect(route.type).toBe('binary');
      expect(route.filename).toBe('balena-etcher_1.18.11_amd64.deb');
    });
  });
});
