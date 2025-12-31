import type { Env, RouteInfo, PackageEntry, RpmPackageEntry } from './types';
import { GitHubClient, getArchitecturesFromAssets } from './github/api';
import { CacheManager, createCacheManager } from './cache/cache';
import {
  generatePackagesFile,
  buildPackageEntry,
  filterDebAssets,
  filterByArchitecture,
} from './generators/packages';
import {
  generateReleaseFile,
  defaultReleaseConfig,
  buildReleaseEntries,
} from './generators/release';
import {
  generateRepomdXml,
  generatePrimaryXml,
  generateFilelistsXml,
  generateOtherXml,
  buildRpmPackageEntry,
  filterRpmAssets,
} from './generators/repodata';
import type { RepomdFileInfo } from './generators/repodata';
import { signCleartext, signDetached, signDetachedBinary, extractPublicKey, getKeyFingerprint } from './signing/gpg';
import { gzipCompress, sha256 } from './utils/crypto';

/**
 * Reprox - Serverless APT/RPM Repository Gateway
 *
 * Translates GitHub Releases into compliant Debian APT and RPM repositories.
 * Uses Range Requests to extract package metadata without downloading full files.
 *
 * APT Routes (Debian/Ubuntu):
 * /{owner}/{repo}/dists/{dist}/InRelease      - GPG cleartext-signed Release
 * /{owner}/{repo}/dists/{dist}/Release        - Unsigned Release metadata
 * /{owner}/{repo}/dists/{dist}/Release.gpg    - Detached GPG signature
 * /{owner}/{repo}/dists/{dist}/{comp}/binary-{arch}/Packages[.gz]
 * /{owner}/{repo}/pool/.../{file}.deb         - Redirects to GitHub download
 *
 * RPM Routes (Fedora/RHEL/CentOS):
 * /{owner}/{repo}/repodata/repomd.xml         - Repository metadata index
 * /{owner}/{repo}/repodata/primary.xml.gz     - Package metadata
 * /{owner}/{repo}/Packages/{file}.rpm         - Redirects to GitHub download
 *
 * Common:
 * /{owner}/{repo}/public.key                  - GPG public key
 */

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      const route = parseRoute(url.pathname);

      // Handle root path - show usage instructions
      if (url.pathname === '/' || url.pathname === '') {
        const baseUrl = `${url.protocol}//${url.host}`;

        // Get fingerprint if GPG key is configured
        let fingerprint: string | null = null;
        const gpgKey = env.GPG_PUBLIC_KEY || env.GPG_PRIVATE_KEY;
        if (gpgKey) {
          try {
            fingerprint = await getKeyFingerprint(gpgKey);
          } catch {
            // Ignore errors - fingerprint is optional
          }
        }

        const aptFingerprintNote = fingerprint
          ? `  # Optional: verify the key fingerprint before importing\n` +
            `  # curl -fsSL ${baseUrl}/{owner}/{repo}/public.key | gpg --show-keys\n` +
            `  # This instance's fingerprint: ${fingerprint}\n\n`
          : '';

        const rpmFingerprintNote = fingerprint
          ? `  # When importing the GPG key, verify this instance's fingerprint:\n` +
            `  # ${fingerprint}\n\n`
          : '';

        return new Response(
          'Reprox - Serverless Github Releases APT/RPM Gateway\n' +
          'https://github.com/leoherzog/reprox\n\n' +
          '=== APT (Debian/Ubuntu) ===\n\n' +
          aptFingerprintNote +
          '  # Import the signing key\n' +
          `  curl -fsSL ${baseUrl}/{owner}/{repo}/public.key | \\\n` +
          '    sudo gpg --dearmor -o /etc/apt/keyrings/{repo}.gpg\n\n' +
          '  # Add the repository\n' +
          `  echo "deb [signed-by=/etc/apt/keyrings/{repo}.gpg] ${baseUrl}/{owner}/{repo} stable main" | \\\n` +
          '    sudo tee /etc/apt/sources.list.d/{repo}.list\n\n' +
          '  # Install\n' +
          '  sudo apt update && sudo apt install {package}\n\n' +
          '=== RPM (Fedora/RHEL/CentOS) ===\n\n' +
          '  sudo tee /etc/yum.repos.d/{repo}.repo << EOF\n' +
          '  [{repo}]\n' +
          '  name={repo} from GitHub via Reprox\n' +
          `  baseurl=${baseUrl}/{owner}/{repo}\n` +
          '  enabled=1\n' +
          '  gpgcheck=0\n' +
          '  repo_gpgcheck=1\n' +
          `  gpgkey=${baseUrl}/{owner}/{repo}/public.key\n` +
          '  EOF\n\n' +
          rpmFingerprintNote +
          '  sudo dnf install {package}\n',
          {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          }
        );
      }

      // Validate route has owner/repo
      if (!route.owner || !route.repo) {
        return new Response('Invalid repository path. Use /{owner}/{repo}/...', { status: 400 });
      }

      // Validate owner/repo format (GitHub naming rules)
      const validNamePattern = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
      if (!validNamePattern.test(route.owner) || route.owner.length > 39) {
        return new Response('Invalid owner name', { status: 400 });
      }
      if (!validNamePattern.test(route.repo) || route.repo.length > 100) {
        return new Response('Invalid repository name', { status: 400 });
      }

      // Initialize services
      const github = new GitHubClient(env.GITHUB_TOKEN);
      const cache = createCacheManager(env.CACHE_TTL);

      // Handle cache invalidation via ?cache=false
      if (url.searchParams.get('cache') === 'false') {
        await cache.clearAllCache(route.owner, route.repo);
      }

      // Route handling
      switch (route.type) {
        case 'public-key':
          return handlePublicKey(env);

        case 'inrelease':
          return handleInRelease(route, github, cache, env, ctx);

        case 'release':
          return handleRelease(route, github, cache, env, ctx);

        case 'release-gpg':
          return handleReleaseGpg(route, github, cache, env, ctx);

        case 'packages':
          return handlePackages(route, github, cache, env, ctx);

        case 'packages-gz':
          return handlePackagesGz(route, github, cache, env, ctx);

        case 'binary':
          return handleBinaryRedirect(route, github);

        case 'by-hash':
          return handleByHash(route, github, cache, env, ctx);

        // RPM routes
        case 'repomd':
          return handleRepomd(route, github, cache, env, ctx);

        case 'repomd-asc':
          return handleRepomdAsc(route, github, cache, env, ctx);

        case 'primary':
          return handleRpmXml(route, github, cache, env, ctx, 'primary', false);

        case 'primary-gz':
          return handleRpmXml(route, github, cache, env, ctx, 'primary', true);

        case 'filelists':
          return handleRpmXml(route, github, cache, env, ctx, 'filelists', false);

        case 'filelists-gz':
          return handleRpmXml(route, github, cache, env, ctx, 'filelists', true);

        case 'other':
          return handleRpmXml(route, github, cache, env, ctx, 'other', false);

        case 'other-gz':
          return handleRpmXml(route, github, cache, env, ctx, 'other', true);

        case 'rpm-binary':
          return handleBinaryRedirect(route, github, 'rpm');

        default:
          return new Response('Not Found', { status: 404 });
      }
    } catch (error) {
      console.error('Request failed:', error);
      const message = error instanceof Error ? error.message : 'Internal Server Error';
      return new Response(message, { status: 500 });
    }
  },
};

/**
 * Parse URL path into route information
 */
export function parseRoute(pathname: string): RouteInfo {
  const parts = pathname.split('/').filter(Boolean);

  const route: RouteInfo = {
    owner: parts[0] || '',
    repo: parts[1] || '',
    distribution: 'stable',
    component: 'main',
    architecture: 'amd64',
    filename: '',
    type: 'unknown',
  };

  // /{owner}/{repo}/public.key
  if (parts[2] === 'public.key') {
    route.type = 'public-key';
    return route;
  }

  // /{owner}/{repo}/dists/{dist}/...
  if (parts[2] === 'dists' && parts[3]) {
    route.distribution = parts[3];

    // /{owner}/{repo}/dists/{dist}/InRelease
    if (parts[4] === 'InRelease') {
      route.type = 'inrelease';
      return route;
    }

    // /{owner}/{repo}/dists/{dist}/Release.gpg
    if (parts[4] === 'Release.gpg') {
      route.type = 'release-gpg';
      return route;
    }

    // /{owner}/{repo}/dists/{dist}/Release
    if (parts[4] === 'Release') {
      route.type = 'release';
      return route;
    }

    // /{owner}/{repo}/dists/{dist}/{component}/binary-{arch}/Packages[.gz]
    if (parts[4] && parts[5]?.startsWith('binary-')) {
      route.component = parts[4];
      route.architecture = parts[5].replace('binary-', '');

      if (parts[6] === 'Packages') {
        route.type = 'packages';
        return route;
      }

      if (parts[6] === 'Packages.gz') {
        route.type = 'packages-gz';
        return route;
      }

      // /{owner}/{repo}/dists/{dist}/{component}/binary-{arch}/by-hash/{hashType}/{hash}
      if (parts[6] === 'by-hash' && parts[7] && parts[8]) {
        route.type = 'by-hash';
        route.hashType = parts[7]; // SHA256, SHA512, etc.
        route.hash = parts[8];
        return route;
      }
    }
  }

  // /{owner}/{repo}/pool/{component}/{prefix}/{package}/{file}.deb
  // APT requests the full pool path from the Packages file's Filename field.
  // We extract just the filename (last segment) to match against GitHub assets.
  if (parts[2] === 'pool') {
    const filename = parts[parts.length - 1];
    if (filename?.endsWith('.deb')) {
      route.type = 'binary';
      route.filename = filename;
      return route;
    }
  }

  // RPM Repository Routes
  // /{owner}/{repo}/repodata/repomd.xml
  if (parts[2] === 'repodata') {
    if (parts[3] === 'repomd.xml') {
      route.type = 'repomd';
      return route;
    }

    // /{owner}/{repo}/repodata/repomd.xml.asc
    if (parts[3] === 'repomd.xml.asc') {
      route.type = 'repomd-asc';
      return route;
    }

    // /{owner}/{repo}/repodata/primary.xml
    if (parts[3] === 'primary.xml') {
      route.type = 'primary';
      return route;
    }

    // /{owner}/{repo}/repodata/primary.xml.gz
    if (parts[3] === 'primary.xml.gz') {
      route.type = 'primary-gz';
      return route;
    }

    // /{owner}/{repo}/repodata/filelists.xml
    if (parts[3] === 'filelists.xml') {
      route.type = 'filelists';
      return route;
    }

    // /{owner}/{repo}/repodata/filelists.xml.gz
    if (parts[3] === 'filelists.xml.gz') {
      route.type = 'filelists-gz';
      return route;
    }

    // /{owner}/{repo}/repodata/other.xml
    if (parts[3] === 'other.xml') {
      route.type = 'other';
      return route;
    }

    // /{owner}/{repo}/repodata/other.xml.gz
    if (parts[3] === 'other.xml.gz') {
      route.type = 'other-gz';
      return route;
    }
  }

  // /{owner}/{repo}/Packages/{file}.rpm
  // RPM package download - redirect to GitHub
  if (parts[2] === 'Packages') {
    const filename = parts[parts.length - 1];
    if (filename?.endsWith('.rpm')) {
      route.type = 'rpm-binary';
      route.filename = filename;
      return route;
    }
  }

  return route;
}

/**
 * Handle public key request - serves GPG public key for APT verification
 */
async function handlePublicKey(env: Env): Promise<Response> {
  if (env.GPG_PUBLIC_KEY) {
    return new Response(env.GPG_PUBLIC_KEY, {
      headers: {
        'Content-Type': 'application/pgp-keys',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }

  if (env.GPG_PRIVATE_KEY) {
    try {
      const publicKey = await extractPublicKey(env.GPG_PRIVATE_KEY);
      return new Response(publicKey, {
        headers: {
          'Content-Type': 'application/pgp-keys',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    } catch (error) {
      console.error('Failed to extract public key:', error);
    }
  }

  return new Response('No GPG key configured', { status: 404 });
}

/**
 * Handle InRelease request - GPG cleartext-signed Release file
 */
async function handleInRelease(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const { owner, repo } = route;

  // Check cache first - avoid GitHub API call if possible
  const cachedReleaseId = await cache.getLatestReleaseId(owner, repo);
  if (cachedReleaseId) {
    const cachedInRelease = await cache.getInReleaseFile(owner, repo);
    if (cachedInRelease) {
      // Verify cache is still valid by checking GitHub (but we already have content to serve)
      // Do validation in background to not block response
      ctx.waitUntil(validateAndRefreshCache(route, github, cache, env, ctx));

      return new Response(cachedInRelease, {
        headers: {
          'Content-Type': 'text/plain',
          'Cache-Control': 'public, max-age=300',
        },
      });
    }
  }

  // No cache - generate fresh content
  const releaseContent = await generateReleaseContent(route, github, cache, env, ctx);

  let response: string;
  if (env.GPG_PRIVATE_KEY) {
    response = await signCleartext(releaseContent, env.GPG_PRIVATE_KEY, env.GPG_PASSPHRASE);
  } else {
    // Return unsigned - client needs [allow-insecure=yes]
    response = releaseContent;
  }

  // Cache in background
  ctx.waitUntil(cache.setInReleaseFile(owner, repo, response));

  return new Response(response, {
    headers: {
      'Content-Type': 'text/plain',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

/**
 * Handle Release request - unsigned Release metadata
 */
async function handleRelease(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const { owner, repo } = route;

  // Check cache first
  const cachedReleaseId = await cache.getLatestReleaseId(owner, repo);
  if (cachedReleaseId) {
    const cachedRelease = await cache.getReleaseFile(owner, repo);
    if (cachedRelease) {
      ctx.waitUntil(validateAndRefreshCache(route, github, cache, env, ctx));

      return new Response(cachedRelease, {
        headers: {
          'Content-Type': 'text/plain',
          'Cache-Control': 'public, max-age=300',
        },
      });
    }
  }

  const releaseContent = await generateReleaseContent(route, github, cache, env, ctx);

  ctx.waitUntil(cache.setReleaseFile(owner, repo, releaseContent));

  return new Response(releaseContent, {
    headers: {
      'Content-Type': 'text/plain',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

/**
 * Handle Release.gpg request - detached GPG signature for Release file
 */
async function handleReleaseGpg(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (!env.GPG_PRIVATE_KEY) {
    return new Response('No GPG key configured for signing', { status: 404 });
  }

  const { owner, repo } = route;

  // Check for cached signature first
  const cachedSignature = await cache.getReleaseGpgSignature(owner, repo);
  if (cachedSignature) {
    // Validate in background
    ctx.waitUntil(validateAndRefreshCache(route, github, cache, env, ctx));
    return new Response(cachedSignature, {
      headers: {
        'Content-Type': 'application/pgp-signature',
        'Cache-Control': 'public, max-age=300',
      },
    });
  }

  // Get or generate Release content
  let releaseContent = await cache.getReleaseFile(owner, repo);
  if (!releaseContent) {
    releaseContent = await generateReleaseContent(route, github, cache, env, ctx);
    ctx.waitUntil(cache.setReleaseFile(owner, repo, releaseContent));
  }

  // Create detached signature and cache it
  const signature = await signDetached(releaseContent, env.GPG_PRIVATE_KEY, env.GPG_PASSPHRASE);
  ctx.waitUntil(cache.setReleaseGpgSignature(owner, repo, signature));

  return new Response(signature, {
    headers: {
      'Content-Type': 'application/pgp-signature',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

/**
 * Background task to validate cache and refresh if needed
 */
async function validateAndRefreshCache(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  try {
    const { owner, repo } = route;
    const latestRelease = await github.getLatestRelease(owner, repo);
    const needsRefresh = await cache.needsRefresh(owner, repo, latestRelease.id);

    if (needsRefresh) {
      // Regenerate all cached content
      await generateAndCacheAll(route, latestRelease, cache, env);
    }
  } catch (error) {
    console.error('Background cache validation failed:', error);
  }
}

/**
 * Generate Release file content with entries for ALL architectures
 */
async function generateReleaseContent(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
  env: Env,
  ctx: ExecutionContext
): Promise<string> {
  const { owner, repo, component } = route;

  // Get latest release from GitHub
  const latestRelease = await github.getLatestRelease(owner, repo);

  // Detect architectures from available assets
  const debAssets = filterDebAssets(latestRelease.assets);
  const architectures = getArchitecturesFromAssets(debAssets);

  // Generate Packages content for each architecture
  const packagesContentByArch = new Map<string, string>();

  for (const arch of architectures) {
    const archAssets = filterByArchitecture(debAssets, arch);
    if (archAssets.length === 0) continue;

    const packages = await generatePackagesContent(
      owner,
      repo,
      latestRelease,
      arch,
      env.GITHUB_TOKEN
    );

    const content = generatePackagesFile(packages);
    packagesContentByArch.set(arch, content);

    // Cache each architecture's Packages file
    ctx.waitUntil(cache.setPackagesFile(owner, repo, arch, content));
  }

  // Build Release config with detected architectures and stable timestamp
  const config = {
    ...defaultReleaseConfig(owner, repo),
    architectures: architectures,
    date: new Date(latestRelease.published_at),
  };

  // Build entries for all architectures
  const entries = await buildReleaseEntries(packagesContentByArch, component);

  // Update cache metadata
  ctx.waitUntil(cache.setLatestReleaseId(owner, repo, latestRelease.id));

  return generateReleaseFile(config, entries);
}

/**
 * Generate and cache all repository metadata
 */
async function generateAndCacheAll(
  route: RouteInfo,
  latestRelease: { id: number; tag_name: string; published_at: string; assets: { name: string; size: number; browser_download_url: string }[] },
  cache: CacheManager,
  env: Env
): Promise<void> {
  const { owner, repo, component } = route;

  const debAssets = filterDebAssets(latestRelease.assets);
  const architectures = getArchitecturesFromAssets(debAssets);
  const packagesContentByArch = new Map<string, string>();

  for (const arch of architectures) {
    const archAssets = filterByArchitecture(debAssets, arch);
    if (archAssets.length === 0) continue;

    const packages = await generatePackagesContent(
      owner,
      repo,
      latestRelease,
      arch,
      env.GITHUB_TOKEN
    );

    const content = generatePackagesFile(packages);
    packagesContentByArch.set(arch, content);
    await cache.setPackagesFile(owner, repo, arch, content);
  }

  const config = {
    ...defaultReleaseConfig(owner, repo),
    architectures: architectures,
    date: new Date(latestRelease.published_at),
  };

  const entries = await buildReleaseEntries(packagesContentByArch, component);
  const releaseContent = generateReleaseFile(config, entries);

  await cache.setReleaseFile(owner, repo, releaseContent);
  await cache.setLatestReleaseId(owner, repo, latestRelease.id);

  if (env.GPG_PRIVATE_KEY) {
    const inRelease = await signCleartext(releaseContent, env.GPG_PRIVATE_KEY, env.GPG_PASSPHRASE);
    await cache.setInReleaseFile(owner, repo, inRelease);

    // Also cache Release.gpg for consistency
    const releaseGpg = await signDetached(releaseContent, env.GPG_PRIVATE_KEY, env.GPG_PASSPHRASE);
    await cache.setReleaseGpgSignature(owner, repo, releaseGpg);
  }
}

/**
 * Handle Packages file request for a specific architecture
 */
async function handlePackages(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const content = await getPackagesContent(route, github, cache, env, ctx);

  return new Response(content, {
    headers: {
      'Content-Type': 'text/plain',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

/**
 * Handle compressed Packages.gz request
 */
async function handlePackagesGz(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const content = await getPackagesContent(route, github, cache, env, ctx);
  const compressed = await gzipCompress(content);

  return new Response(compressed, {
    headers: {
      'Content-Type': 'application/gzip',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

/**
 * Handle by-hash request - serves files by their SHA256/SHA512 hash
 * This allows APT to fetch consistent content during repository updates
 */
async function handleByHash(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const { hashType, hash } = route;

  if (!hashType || !hash) {
    return new Response('Invalid by-hash request', { status: 400 });
  }

  // We support SHA256 hashes
  if (hashType !== 'SHA256') {
    return new Response(`Unsupported hash type: ${hashType}`, { status: 404 });
  }

  // Generate both Packages and Packages.gz content
  const packagesContent = await getPackagesContent(route, github, cache, env, ctx);
  const packagesGz = await gzipCompress(packagesContent);

  // Calculate hashes for both formats
  const packagesHash = await sha256(packagesContent);
  const packagesGzHash = await sha256(packagesGz);

  // Check if the requested hash matches either file
  if (hash === packagesHash) {
    return new Response(packagesContent, {
      headers: {
        'Content-Type': 'text/plain',
        'Cache-Control': 'public, max-age=86400', // Longer cache for by-hash (immutable content)
      },
    });
  }

  if (hash === packagesGzHash) {
    return new Response(packagesGz, {
      headers: {
        'Content-Type': 'application/gzip',
        'Cache-Control': 'public, max-age=86400', // Longer cache for by-hash (immutable content)
      },
    });
  }

  // Hash not found - might be an old version
  return new Response(`Hash not found: ${hash}`, { status: 404 });
}

/**
 * Get or generate Packages file content for a specific architecture
 */
async function getPackagesContent(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
  env: Env,
  ctx: ExecutionContext
): Promise<string> {
  const { owner, repo, architecture } = route;

  // Check cache first
  const cachedReleaseId = await cache.getLatestReleaseId(owner, repo);
  if (cachedReleaseId) {
    const cached = await cache.getPackagesFile(owner, repo, architecture);
    if (cached) {
      // Validate in background
      ctx.waitUntil(validateAndRefreshCache(route, github, cache, env, ctx));
      return cached;
    }
  }

  // Generate fresh packages content
  const latestRelease = await github.getLatestRelease(owner, repo);

  const packages = await generatePackagesContent(
    owner,
    repo,
    latestRelease,
    architecture,
    env.GITHUB_TOKEN
  );

  const content = generatePackagesFile(packages);

  // Cache in background
  ctx.waitUntil(
    Promise.all([
      cache.setPackagesFile(owner, repo, architecture, content),
      cache.setLatestReleaseId(owner, repo, latestRelease.id),
    ])
  );

  return content;
}

/**
 * Generate packages content from GitHub release for a specific architecture
 */
async function generatePackagesContent(
  owner: string,
  repo: string,
  release: { id: number; tag_name: string; assets: { name: string; size: number; browser_download_url: string }[] },
  architecture: string,
  githubToken?: string
): Promise<PackageEntry[]> {
  // Filter to .deb files for this architecture
  let assets = filterDebAssets(release.assets);
  assets = filterByArchitecture(assets, architecture);

  // Build package entries in parallel (fetches metadata via Range requests)
  const entries = await Promise.all(
    assets.map(async (asset) => {
      try {
        return await buildPackageEntry(asset, owner, repo, release.tag_name, githubToken);
      } catch (error) {
        console.error(`Failed to process ${asset.name}:`, error);
        return null;
      }
    })
  );

  // Filter out failed entries
  return entries.filter((e): e is PackageEntry => e !== null);
}

/**
 * Handle binary (.deb) redirect to GitHub
 *
 * APT requests files using the Filename from the Packages file, which uses
 * pool-style paths: pool/main/h/hello/hello_1.0_amd64.deb
 *
 * We extract just the filename (last segment) and find the matching
 * GitHub release asset to redirect to.
 */
async function handleBinaryRedirect(
  route: RouteInfo,
  github: GitHubClient,
  packageType: 'deb' | 'rpm' = 'deb'
): Promise<Response> {
  const { owner, repo, filename } = route;
  const typeName = packageType === 'deb' ? 'Asset' : 'RPM package';

  try {
    const release = await github.getLatestRelease(owner, repo);
    const asset = release.assets.find(a => a.name === filename);

    if (!asset) {
      return new Response(`${typeName} not found: ${filename}`, { status: 404 });
    }

    // 302 redirect to GitHub's CDN - offloads bandwidth from Worker
    return Response.redirect(asset.browser_download_url, 302);
  } catch (error) {
    console.error(`${typeName} redirect failed:`, error);
    return new Response(`${typeName} not found`, { status: 404 });
  }
}

// =============================================================================
// RPM Repository Handlers
// =============================================================================

/**
 * Get or generate repomd.xml and its signature together
 * This ensures both are consistent (signature matches content)
 */
async function getRepomdWithSignature(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
  env: Env,
  ctx: ExecutionContext
): Promise<{ repomd: string; signature: string | null }> {
  const { owner, repo } = route;

  // Check cache first
  const [cachedRepomd, cachedSignature] = await Promise.all([
    cache.getRpmRepomd(owner, repo),
    cache.getRpmRepomdAsc(owner, repo),
  ]);

  // If we have cached content (and signature if GPG is configured), use it
  if (cachedRepomd && (cachedSignature || !env.GPG_PRIVATE_KEY)) {
    // Validate cache in background
    ctx.waitUntil(validateAndRefreshRepomd(route, github, cache, env, ctx));
    return { repomd: cachedRepomd, signature: cachedSignature };
  }

  // Generate fresh content
  const files = await getRpmMetadataFiles(route, github, cache, env, ctx);
  const repomdXml = await generateRepomdXml(files);

  // Sign if GPG key is available
  let signature: string | null = null;
  if (env.GPG_PRIVATE_KEY) {
    signature = await signDetachedBinary(repomdXml, env.GPG_PRIVATE_KEY, env.GPG_PASSPHRASE);
  }

  // Cache both together in background
  ctx.waitUntil(
    Promise.all([
      cache.setRpmRepomd(owner, repo, repomdXml),
      signature ? cache.setRpmRepomdAsc(owner, repo, signature) : Promise.resolve(),
    ])
  );

  return { repomd: repomdXml, signature };
}

/**
 * Background task to validate and refresh repomd cache if needed
 */
async function validateAndRefreshRepomd(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  try {
    const { owner, repo } = route;
    const latestRelease = await github.getLatestRelease(owner, repo);
    const needsRefresh = await cache.needsRefresh(owner, repo, latestRelease.id);

    if (needsRefresh) {
      // Regenerate repomd and signature
      const files = await getRpmMetadataFiles(route, github, cache, env, ctx);
      const repomdXml = await generateRepomdXml(files);

      const cachePromises: Promise<void>[] = [
        cache.setRpmRepomd(owner, repo, repomdXml),
      ];

      if (env.GPG_PRIVATE_KEY) {
        const signature = await signDetachedBinary(repomdXml, env.GPG_PRIVATE_KEY, env.GPG_PASSPHRASE);
        cachePromises.push(cache.setRpmRepomdAsc(owner, repo, signature));
      }

      await Promise.all(cachePromises);
    }
  } catch (error) {
    console.error('Background repomd cache validation failed:', error);
  }
}

/**
 * Handle repomd.xml request - RPM repository metadata index
 */
async function handleRepomd(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const { repomd } = await getRepomdWithSignature(route, github, cache, env, ctx);

  return new Response(repomd, {
    headers: {
      'Content-Type': 'application/xml',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

/**
 * Handle repomd.xml.asc request - GPG signature for repomd.xml
 */
async function handleRepomdAsc(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (!env.GPG_PRIVATE_KEY) {
    return new Response('GPG signing not configured', { status: 404 });
  }

  const { signature } = await getRepomdWithSignature(route, github, cache, env, ctx);

  if (!signature) {
    return new Response('Signature generation failed', { status: 500 });
  }

  return new Response(signature, {
    headers: {
      'Content-Type': 'application/pgp-signature',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

/**
 * Helper to create RPM XML response (with optional gzip compression)
 */
async function createRpmXmlResponse(
  content: string,
  compressed: boolean
): Promise<Response> {
  if (compressed) {
    const gzipped = await gzipCompress(content);
    return new Response(gzipped, {
      headers: {
        'Content-Type': 'application/gzip',
        'Cache-Control': 'public, max-age=300',
      },
    });
  }

  return new Response(content, {
    headers: {
      'Content-Type': 'application/xml',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

/**
 * Build RPM package entries from assets
 */
async function buildRpmPackages(
  assets: { name: string; size: number; browser_download_url: string }[],
  githubToken?: string
): Promise<RpmPackageEntry[]> {
  const rpmAssets = filterRpmAssets(assets);

  const entries = await Promise.all(
    rpmAssets.map(async (asset) => {
      try {
        return await buildRpmPackageEntry(asset, githubToken);
      } catch (error) {
        console.error(`Failed to process ${asset.name}:`, error);
        return null;
      }
    })
  );

  return entries.filter((e): e is RpmPackageEntry => e !== null);
}

/**
 * RPM XML content (without timestamp)
 */
interface RpmXmlContent {
  primaryXml: string;
  filelistsXml: string;
  otherXml: string;
}

/**
 * Cached RPM metadata content (includes timestamp)
 */
interface CachedRpmMetadata extends RpmXmlContent {
  timestamp: number; // Unix timestamp from GitHub release
}

/**
 * Generate all RPM XML metadata from packages
 */
function generateRpmXmlMetadata(packages: RpmPackageEntry[]): RpmXmlContent {
  return {
    primaryXml: generatePrimaryXml(packages),
    filelistsXml: generateFilelistsXml(packages),
    otherXml: generateOtherXml(packages),
  };
}

type RpmXmlType = 'primary' | 'filelists' | 'other';

/**
 * Handle RPM XML metadata requests (primary.xml, filelists.xml, other.xml)
 */
async function handleRpmXml(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
  env: Env,
  ctx: ExecutionContext,
  xmlType: RpmXmlType,
  compressed: boolean
): Promise<Response> {
  const metadata = await getCachedRpmMetadata(route, github, cache, env, ctx);
  const xmlContent = metadata[`${xmlType}Xml` as keyof RpmXmlContent];
  return createRpmXmlResponse(xmlContent, compressed);
}

/**
 * Get or generate RPM metadata with caching
 */
async function getCachedRpmMetadata(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
  env: Env,
  ctx: ExecutionContext
): Promise<CachedRpmMetadata> {
  const { owner, repo } = route;

  // Check cache first
  const cachedReleaseId = await cache.getLatestReleaseId(owner, repo);
  if (cachedReleaseId) {
    const [cachedPrimary, cachedFilelists, cachedOther, cachedTimestamp] = await Promise.all([
      cache.getRpmPrimaryXml(owner, repo),
      cache.getRpmFilelistsXml(owner, repo),
      cache.getRpmOtherXml(owner, repo),
      cache.getRpmTimestamp(owner, repo),
    ]);

    if (cachedPrimary && cachedFilelists && cachedOther && cachedTimestamp) {
      // Validate in background
      ctx.waitUntil(validateAndRefreshRpmCache(route, github, cache, env, ctx));

      return {
        primaryXml: cachedPrimary,
        filelistsXml: cachedFilelists,
        otherXml: cachedOther,
        timestamp: cachedTimestamp,
      };
    }
  }

  // No cache - generate fresh content
  const latestRelease = await github.getLatestRelease(owner, repo);
  const packages = await buildRpmPackages(latestRelease.assets, env.GITHUB_TOKEN);
  const metadata = generateRpmXmlMetadata(packages);

  // Convert GitHub published_at to Unix timestamp
  const timestamp = Math.floor(new Date(latestRelease.published_at).getTime() / 1000);

  // Cache in background
  ctx.waitUntil(
    Promise.all([
      cache.setRpmPrimaryXml(owner, repo, metadata.primaryXml),
      cache.setRpmFilelistsXml(owner, repo, metadata.filelistsXml),
      cache.setRpmOtherXml(owner, repo, metadata.otherXml),
      cache.setRpmTimestamp(owner, repo, timestamp),
      cache.setLatestReleaseId(owner, repo, latestRelease.id),
    ])
  );

  return { ...metadata, timestamp };
}

/**
 * Background task to validate and refresh RPM cache if needed
 */
async function validateAndRefreshRpmCache(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  try {
    const { owner, repo } = route;
    const latestRelease = await github.getLatestRelease(owner, repo);
    const needsRefresh = await cache.needsRefresh(owner, repo, latestRelease.id);

    if (needsRefresh) {
      const packages = await buildRpmPackages(latestRelease.assets, env.GITHUB_TOKEN);
      const metadata = generateRpmXmlMetadata(packages);
      const timestamp = Math.floor(new Date(latestRelease.published_at).getTime() / 1000);

      await Promise.all([
        cache.setRpmPrimaryXml(owner, repo, metadata.primaryXml),
        cache.setRpmFilelistsXml(owner, repo, metadata.filelistsXml),
        cache.setRpmOtherXml(owner, repo, metadata.otherXml),
        cache.setRpmTimestamp(owner, repo, timestamp),
        cache.setLatestReleaseId(owner, repo, latestRelease.id),
      ]);
    }
  } catch (error) {
    console.error('Background RPM cache validation failed:', error);
  }
}

/**
 * Get all RPM metadata files for repomd.xml generation
 */
async function getRpmMetadataFiles(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
  env: Env,
  ctx: ExecutionContext
): Promise<RepomdFileInfo> {
  const metadata = await getCachedRpmMetadata(route, github, cache, env, ctx);

  // Compress all files
  const [primaryGz, filelistsGz, otherGz] = await Promise.all([
    gzipCompress(metadata.primaryXml),
    gzipCompress(metadata.filelistsXml),
    gzipCompress(metadata.otherXml),
  ]);

  return {
    primary: { xml: metadata.primaryXml, gz: primaryGz },
    filelists: { xml: metadata.filelistsXml, gz: filelistsGz },
    other: { xml: metadata.otherXml, gz: otherGz },
    timestamp: metadata.timestamp,
  };
}
