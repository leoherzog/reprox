import type { Env, RouteInfo, PackageEntry, RpmPackageEntry, GitHubRelease, GitHubAsset } from './types';
import { GitHubClient, getArchitecturesFromAssets, githubHeaders } from './github/api';
import { CacheManager, createCacheManager, computeReleaseIdsHash, type ReleaseVariant } from './cache/cache';
import { mapWithConcurrencyFiltered } from './utils/concurrency';
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
  buildRepomd,
  generatePrimaryXml,
  generateFilelistsXml,
  generateOtherXml,
  buildRpmPackageEntry,
  filterRpmAssets,
} from './generators/repodata';
import type { RepomdHashes } from './generators/repodata';
import { signCleartext, signDetached, signDetachedBinary, extractPublicKey, getKeyFingerprint } from './signing/gpg';
import { gzipCompress, sha256 } from './utils/crypto';
import { README_HTML, README_MARKDOWN } from './generated/readme-html';

const apiHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=300',
} as const;

const validNamePattern = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

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

      // Handle root path - serve static README with dynamic replacements
      if (url.pathname === '/') {
        return handleReadme(request, url, env);
      }

      // Handle favicon request
      if (url.pathname === '/favicon.ico' || url.pathname === '/favicon.svg') {
        return handleFavicon();
      }

      // Handle search API - proxies GitHub search with auth token and caching
      if (url.pathname === '/_/search') {
        return handleSearchApi(url, env);
      }

      // Handle package name extraction from latest release
      if (url.pathname === '/_/package') {
        return handlePackageApi(url, env);
      }

      // Validate route has owner/repo
      if (!route.owner || !route.repo) {
        return new Response('Invalid repository path. Use /{owner}/{repo}/...', { status: 400 });
      }

      // Validate owner/repo format (GitHub naming rules)
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
          return handleBinaryRedirect(route, github, cache, env);

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
          return handleBinaryRedirect(route, github, cache, env, 'rpm');

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

  // Detect /prerelease segment and calculate offset for subsequent parts
  // /{owner}/{repo}/prerelease/... or /{owner}/{repo}/...
  const hasPrerelease = parts[2] === 'prerelease';
  const offset = hasPrerelease ? 1 : 0;

  // Helper to get part with offset applied (for parts after owner/repo)
  const p = (index: number) => parts[index + offset];

  const route: RouteInfo = {
    owner: parts[0] || '',
    repo: parts[1] || '',
    distribution: 'stable',
    component: 'main',
    architecture: 'amd64',
    filename: '',
    releaseVariant: hasPrerelease ? 'prerelease' : 'stable',
    type: 'unknown',
  };

  // /{owner}/{repo}(/prerelease)?/public.key
  if (p(2) === 'public.key') {
    route.type = 'public-key';
    return route;
  }

  // /{owner}/{repo}(/prerelease)?/dists/{dist}/...
  if (p(2) === 'dists' && p(3)) {
    route.distribution = p(3);

    // /{owner}/{repo}(/prerelease)?/dists/{dist}/InRelease
    if (p(4) === 'InRelease') {
      route.type = 'inrelease';
      return route;
    }

    // /{owner}/{repo}(/prerelease)?/dists/{dist}/Release.gpg
    if (p(4) === 'Release.gpg') {
      route.type = 'release-gpg';
      return route;
    }

    // /{owner}/{repo}(/prerelease)?/dists/{dist}/Release
    if (p(4) === 'Release') {
      route.type = 'release';
      return route;
    }

    // /{owner}/{repo}(/prerelease)?/dists/{dist}/{component}/binary-{arch}/Packages[.gz]
    if (p(4) && p(5)?.startsWith('binary-')) {
      route.component = p(4);
      route.architecture = p(5).replace('binary-', '');

      if (p(6) === 'Packages') {
        route.type = 'packages';
        return route;
      }

      if (p(6) === 'Packages.gz') {
        route.type = 'packages-gz';
        return route;
      }

      // /{owner}/{repo}(/prerelease)?/dists/{dist}/{component}/binary-{arch}/by-hash/{hashType}/{hash}
      if (p(6) === 'by-hash' && p(7) && p(8)) {
        route.type = 'by-hash';
        route.hashType = p(7); // SHA256, SHA512, etc.
        route.hash = p(8);
        return route;
      }
    }
  }

  // /{owner}/{repo}(/prerelease)?/pool/{component}/{prefix}/{package}/{file}.deb
  // APT requests the full pool path from the Packages file's Filename field.
  // We extract just the filename (last segment) to match against GitHub assets.
  if (p(2) === 'pool') {
    const filename = parts[parts.length - 1];
    if (filename?.endsWith('.deb')) {
      route.type = 'binary';
      route.filename = filename;
      return route;
    }
  }

  // RPM Repository Routes
  // /{owner}/{repo}(/prerelease)?/repodata/{file}
  if (p(2) === 'repodata') {
    const file = p(3);

    const staticRoutes: Record<string, RouteInfo['type']> = {
      'repomd.xml': 'repomd',
      'repomd.xml.asc': 'repomd-asc',
      // Unhashed metadata paths are kept for legacy/debugging requests.
      // Current repomd.xml always emits hashed paths (see below).
      'primary.xml': 'primary',
      'primary.xml.gz': 'primary-gz',
      'filelists.xml': 'filelists',
      'filelists.xml.gz': 'filelists-gz',
      'other.xml': 'other',
      'other.xml.gz': 'other-gz',
    };
    const staticRouteType = staticRoutes[file];
    if (staticRouteType) {
      route.type = staticRouteType;
      return route;
    }

    // Hashed metadata files: `{sha256}-{kind}.xml[.gz]` (unique_md_filenames
    // convention). Match the hash prefix and route to the content-addressed
    // blob handler.
    const hashedMatch = file?.match(/^([0-9a-f]{64})-(primary|filelists|other)\.xml(\.gz)?$/);
    if (hashedMatch) {
      const [, hash, kind, gzSuffix] = hashedMatch;
      const kindToType: Record<string, { plain: RouteInfo['type']; gz: RouteInfo['type'] }> = {
        primary:   { plain: 'primary',   gz: 'primary-gz' },
        filelists: { plain: 'filelists', gz: 'filelists-gz' },
        other:     { plain: 'other',     gz: 'other-gz' },
      };
      route.type = gzSuffix ? kindToType[kind].gz : kindToType[kind].plain;
      route.hash = hash;
      return route;
    }
  }

  // /{owner}/{repo}(/prerelease)?/Packages/{file}.rpm
  // RPM package download - redirect to GitHub
  if (p(2) === 'Packages') {
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
 * Aggregate assets from multiple releases into a single array
 */
function aggregateAssets(releases: GitHubRelease[]): GitHubAsset[] {
  return releases.flatMap(release => release.assets);
}

/**
 * Most recent non-null published_at as a Date. Falls back to now if every
 * release has a null published_at (a draft can slip in between pagination
 * pages if the release was demoted mid-query).
 */
function mostRecentReleaseDate(releases: GitHubRelease[]): Date {
  for (const r of releases) {
    if (r.published_at !== null) return new Date(r.published_at);
  }
  return new Date();
}

/**
 * Unix seconds of the most recent non-null published_at, or now if none.
 */
function mostRecentReleaseTimestamp(releases: GitHubRelease[]): number {
  for (const r of releases) {
    if (r.published_at !== null) {
      return Math.floor(new Date(r.published_at).getTime() / 1000);
    }
  }
  return Math.floor(Date.now() / 1000);
}

/**
 * Handle root path request - serve pre-built static README
 * with dynamic baseUrl and fingerprint replacements
 */
async function handleReadme(request: Request, url: URL, env: Env): Promise<Response> {
  const baseUrl = `${url.protocol}//${url.host}`;

  // Get fingerprint if GPG key is configured
  let fingerprintComment = '';
  let fingerprintFooter = '';
  const gpgKey = env.GPG_PUBLIC_KEY || env.GPG_PRIVATE_KEY;
  if (gpgKey) {
    try {
      const fingerprint = await getKeyFingerprint(gpgKey);
      fingerprintComment = `This instance's fingerprint: ${fingerprint}`;
      fingerprintFooter = ` · Fingerprint: ${fingerprint}`;
    } catch {
      // Ignore errors - fingerprint is optional
    }
  }

  // Content negotiation: HTML for browsers, markdown for CLI/APIs
  const acceptHeader = request.headers.get('Accept') || '';
  if (acceptHeader.includes('text/html')) {
    // Serve pre-built static HTML
    const html = README_HTML
      .replace(/\{\{BASE_URL\}\}/g, baseUrl)
      .replace(/\{\{FINGERPRINT_COMMENT\}\}/g, fingerprintComment)
      .replace(/\{\{FINGERPRINT_FOOTER\}\}/g, fingerprintFooter);

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
    });
  }

  // Non-browser: serve pre-built static markdown
  const markdown = README_MARKDOWN
    .replace(/\{\{BASE_URL\}\}/g, baseUrl)
    .replace(/\{\{FINGERPRINT_COMMENT\}\}/g, fingerprintComment);

  return new Response(markdown, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

/**
 * Handle favicon request - serves SVG favicon with light/dark mode support
 */
function handleFavicon(): Response {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640">
  <style>
    path { fill: #1f2328; }
    @media (prefers-color-scheme: dark) {
      path { fill: #f0f6fc; }
    }
  </style>
  <path d="M432 96C387.8 96 352 131.8 352 176L352 424.2L54.8 513.4C37.9 518.4 28.3 536.3 33.4 553.2C38.5 570.1 56.3 579.7 73.2 574.7L388.7 480.1L432.4 480.1C432.2 482.7 432 485.4 432 488.1C432 536.7 471.4 576.1 520 576.1C568.6 576.1 608 536.7 608 488.1L608 96.1L432 96.1zM560 488C560 510.1 542.1 528 520 528C497.9 528 480 510.1 480 488C480 465.9 497.9 448 520 448C542.1 448 559.9 465.9 560 487.9L560 488zM83.9 213.5C50.1 223.8 31.1 259.6 41.4 293.4L69.5 385.2C79.8 419 115.6 438 149.4 427.7L241.2 399.6C275 389.3 294 353.5 283.7 319.7L255.6 227.9C245.3 194.1 209.5 175.1 175.7 185.4L83.9 213.5z"/>
</svg>`;

  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

/**
 * Handle search API request - proxies GitHub repository search
 * with authenticated token for higher rate limits and caches results
 */
async function handleSearchApi(url: URL, env: Env): Promise<Response> {
  const query = url.searchParams.get('q')?.trim();
  if (!query || query.length < 2 || query.length > 256) {
    return new Response(JSON.stringify({ items: [] }), { headers: apiHeaders });
  }

  // Check cache first
  const cache = await caches.open('reprox');
  const cacheKey = new Request(`https://reprox.internal/search/${encodeURIComponent(query)}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // Proxy to GitHub search API with auth
  const ghResponse = await fetch(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+in:name&per_page=8&sort=stars`,
    { headers: githubHeaders(env.GITHUB_TOKEN) }
  );

  if (!ghResponse.ok) {
    return new Response(JSON.stringify({ error: 'Search failed' }), {
      status: ghResponse.status,
      headers: apiHeaders,
    });
  }

  const data = await ghResponse.json() as { items?: Array<{ full_name: string; description: string | null; stargazers_count: number }> };
  const items = (data.items || []).map(r => ({
    full_name: r.full_name,
    description: r.description,
    stargazers_count: r.stargazers_count,
  }));

  const response = new Response(JSON.stringify({ items }), { headers: apiHeaders });
  await cache.put(cacheKey, response.clone());

  return response;
}

/**
 * Handle package name extraction API - fetches latest release assets
 * and extracts the package name from .deb/.rpm filenames
 */
async function handlePackageApi(url: URL, env: Env): Promise<Response> {
  const owner = url.searchParams.get('owner')?.trim();
  const repo = url.searchParams.get('repo')?.trim();
  if (!owner || !repo) {
    return new Response(JSON.stringify({ package: '', hasPackages: false }), { headers: apiHeaders });
  }

  if (!validNamePattern.test(owner) || owner.length > 39 ||
      !validNamePattern.test(repo) || repo.length > 100) {
    return new Response(JSON.stringify({ package: '', hasPackages: false }), { headers: apiHeaders });
  }

  // Check cache first
  const cache = await caches.open('reprox');
  const cacheKey = new Request(`https://reprox.internal/package/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // Fetch latest release with auth
  const ghResponse = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`,
    { headers: githubHeaders(env.GITHUB_TOKEN) }
  );

  if (!ghResponse.ok) {
    return new Response(
      JSON.stringify({ package: repo, hasPackages: false }),
      { headers: apiHeaders }
    );
  }

  const release = await ghResponse.json() as { assets?: Array<{ name: string }> };
  const assets = release.assets || [];

  let packageName = repo;
  let hasPackages = false;

  for (const asset of assets) {
    const name = asset.name;
    if (name.endsWith('.deb')) {
      hasPackages = true;
      const match = name.match(/^([a-z0-9][a-z0-9.+\-]*?)_\d/);
      if (match) {
        packageName = match[1];
        break;
      }
    } else if (name.endsWith('.rpm')) {
      hasPackages = true;
      const match = name.match(/^([a-zA-Z0-9][a-zA-Z0-9._+\-]*?)-\d/);
      if (match) {
        packageName = match[1];
        break;
      }
    }
  }

  const body = JSON.stringify({ package: packageName, hasPackages });
  const response = new Response(body, { headers: apiHeaders });
  await cache.put(cacheKey, response.clone());

  return response;
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
  const { owner, repo, releaseVariant } = route;

  // Check cache first - avoid GitHub API call if possible
  const cachedHash = await cache.getReleaseIdsHash(owner, repo, releaseVariant);
  if (cachedHash) {
    const cachedInRelease = await cache.getInReleaseFile(owner, repo, releaseVariant);
    if (cachedInRelease) {
      // Verify cache is still valid by checking GitHub (but we already have content to serve)
      // Do validation in background to not block response
      ctx.waitUntil(validateAndRefreshCache(route, github, cache, env));

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

  // Cache both the signed InRelease and the underlying Release bytes so
  // follow-up requests (Release, Release.gpg, binary-{arch}/Packages[.gz]
  // which resolves blobs via the cached Release's SHA256 section) don't
  // re-fetch all of GitHub.
  ctx.waitUntil(Promise.all([
    cache.setInReleaseFile(owner, repo, releaseVariant, response),
    cache.setReleaseFile(owner, repo, releaseVariant, releaseContent),
  ]));

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
  const { owner, repo, releaseVariant } = route;

  // Check cache first
  const cachedHash = await cache.getReleaseIdsHash(owner, repo, releaseVariant);
  if (cachedHash) {
    const cachedRelease = await cache.getReleaseFile(owner, repo, releaseVariant);
    if (cachedRelease) {
      ctx.waitUntil(validateAndRefreshCache(route, github, cache, env));

      return new Response(cachedRelease, {
        headers: {
          'Content-Type': 'text/plain',
          'Cache-Control': 'public, max-age=300',
        },
      });
    }
  }

  const releaseContent = await generateReleaseContent(route, github, cache, env, ctx);

  ctx.waitUntil(cache.setReleaseFile(owner, repo, releaseVariant, releaseContent));

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

  const { owner, repo, releaseVariant } = route;

  // Check for cached signature first
  const cachedSignature = await cache.getReleaseGpgSignature(owner, repo, releaseVariant);
  if (cachedSignature) {
    // Validate in background
    ctx.waitUntil(validateAndRefreshCache(route, github, cache, env));
    return new Response(cachedSignature, {
      headers: {
        'Content-Type': 'application/pgp-signature',
        'Cache-Control': 'public, max-age=300',
      },
    });
  }

  // Get or generate Release content
  let releaseContent = await cache.getReleaseFile(owner, repo, releaseVariant);
  if (!releaseContent) {
    releaseContent = await generateReleaseContent(route, github, cache, env, ctx);
    ctx.waitUntil(cache.setReleaseFile(owner, repo, releaseVariant, releaseContent));
  }

  // Create detached signature and cache it
  const signature = await signDetached(releaseContent, env.GPG_PRIVATE_KEY, env.GPG_PASSPHRASE);
  ctx.waitUntil(cache.setReleaseGpgSignature(owner, repo, releaseVariant, signature));

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
  env: Env
): Promise<void> {
  try {
    const { owner, repo, releaseVariant } = route;
    const includePrerelease = releaseVariant === 'prerelease';
    const releases = await github.getAllReleases(owner, repo, includePrerelease);

    if (releases.length === 0) return;

    const currentHash = await computeReleaseIdsHash(releases);
    const needsRefresh = await cache.needsRefresh(owner, repo, releaseVariant, currentHash);

    if (needsRefresh) {
      // Regenerate all cached content
      await generateAndCacheAll(route, releases, cache, env);
    }
  } catch (error) {
    console.error('Background cache validation failed:', error);
  }
}

/**
 * Generate Release file content with entries for ALL architectures.
 *
 * Writes each arch's Packages + Packages.gz into the content-addressed
 * `packages-blob/.../{sha256}` keyspace BEFORE returning the Release bytes
 * (which pin those SHA256s), so any follow-up fetch — whether by-hash or the
 * legacy `binary-{arch}/Packages[.gz]` URL (which resolves by reading the
 * cached Release's SHA256 and looking up the blob) — always resolves to the
 * exact bytes Release hashed over.
 */
async function generateReleaseContent(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
  env: Env,
  ctx: ExecutionContext
): Promise<string> {
  const { owner, repo, component, releaseVariant } = route;

  // Get all releases from GitHub
  const includePrerelease = releaseVariant === 'prerelease';
  const releases = await github.getAllReleases(owner, repo, includePrerelease);

  if (releases.length === 0) {
    throw new Error(`No releases found for ${owner}/${repo}`);
  }

  // Aggregate assets from all releases
  const allAssets = aggregateAssets(releases);

  // Detect architectures from available assets
  const debAssets = filterDebAssets(allAssets);
  const architectures = getArchitecturesFromAssets(debAssets);

  // Generate Packages content for all architectures in parallel
  const packagesContentByArch = new Map<string, string>();

  const archResults = await Promise.all(
    architectures.map(async (arch) => {
      const archAssets = filterByArchitecture(debAssets, arch);
      if (archAssets.length === 0) return null;

      const packages = await generatePackagesContentMultiRelease(
        owner,
        repo,
        archAssets,
        env.GITHUB_TOKEN
      );

      const content = generatePackagesFile(packages);
      return { arch, content };
    })
  );

  // Write content-addressed blobs FIRST (before any Release bytes escape).
  // Awaited so the blobs exist by the time the caller signs/returns the
  // Release file.
  const filteredResults = archResults.filter(
    (result): result is { arch: string; content: string } => result !== null
  );
  await Promise.all(
    filteredResults.map(async ({ arch, content }) => {
      packagesContentByArch.set(arch, content);
      await writeAptPackagesBlobs(cache, owner, repo, releaseVariant, content);
    })
  );

  // Build Release config with detected architectures and most recent release timestamp
  const config = {
    ...defaultReleaseConfig(owner, repo),
    architectures: architectures,
    date: mostRecentReleaseDate(releases),
  };

  // Build entries for all architectures
  const entries = await buildReleaseEntries(packagesContentByArch, component);

  // Update cache metadata with release IDs hash
  const releaseIdsHash = await computeReleaseIdsHash(releases);
  ctx.waitUntil(cache.setReleaseIdsHash(owner, repo, releaseVariant, releaseIdsHash));

  return generateReleaseFile(config, entries);
}

/**
 * Write the two content-addressed APT Packages blobs for a single
 * architecture (uncompressed + gzipped), each keyed by its own SHA256. Blobs
 * are immutable; the legacy `binary-{arch}/Packages[.gz]` URL serves them by
 * reading the current Release's SHA256 and doing a blob lookup.
 */
async function writeAptPackagesBlobs(
  cache: CacheManager,
  owner: string,
  repo: string,
  variant: ReleaseVariant,
  content: string
): Promise<void> {
  const bytes = new TextEncoder().encode(content);
  const gz = await gzipCompress(bytes);
  const [contentSha, gzSha] = await Promise.all([sha256(bytes), sha256(gz)]);
  await Promise.all([
    cache.setPackagesBlob(owner, repo, variant, contentSha, bytes, 'text/plain'),
    cache.setPackagesBlob(owner, repo, variant, gzSha, gz, 'application/gzip'),
  ]);
}

/**
 * Generate and cache all APT repository metadata.
 *
 * Builds Packages content for every arch and writes the content-addressed
 * `packages-blob/.../{sha256}` entries BEFORE writing the
 * Release/InRelease/Release.gpg files that pin those SHA256s. Mirrors the
 * RPM `cacheRpmSnapshot` pattern: any client that ends up reading the
 * cached Release can resolve every reference — whether the client fetches
 * by-hash or uses the legacy `binary-{arch}/Packages[.gz]` URL (which does
 * the same blob lookup server-side) — against the exact bytes Release
 * hashed over, eliminating the "Hash Sum mismatch" race.
 */
async function generateAndCacheAll(
  route: RouteInfo,
  releases: GitHubRelease[],
  cache: CacheManager,
  env: Env
): Promise<void> {
  const { owner, repo, component, releaseVariant } = route;

  if (releases.length === 0) return;

  // Compute release hash for cache invalidation
  const releaseHash = await computeReleaseIdsHash(releases);

  // Aggregate assets from all releases
  const allAssets = aggregateAssets(releases);

  // Cache all asset URLs for efficient binary redirects (keyed by release hash for auto-invalidation)
  await cache.setAssetUrls(owner, repo, releaseVariant, releaseHash, allAssets);

  const debAssets = filterDebAssets(allAssets);
  const architectures = getArchitecturesFromAssets(debAssets);
  const packagesContentByArch = new Map<string, string>();

  // Generate Packages content for all architectures in parallel
  const archResults = await Promise.all(
    architectures.map(async (arch) => {
      const archAssets = filterByArchitecture(debAssets, arch);
      if (archAssets.length === 0) return null;

      const packages = await generatePackagesContentMultiRelease(
        owner,
        repo,
        archAssets,
        env.GITHUB_TOKEN
      );

      const content = generatePackagesFile(packages);
      return { arch, content };
    })
  );

  // Write content-addressed blobs BEFORE Release bytes are persisted. Blob
  // writes are awaited so a subsequent read of the cached Release always
  // resolves its references.
  await Promise.all(
    archResults
      .filter((result): result is { arch: string; content: string } => result !== null)
      .map(async ({ arch, content }) => {
        packagesContentByArch.set(arch, content);
        await writeAptPackagesBlobs(cache, owner, repo, releaseVariant, content);
      })
  );

  const config = {
    ...defaultReleaseConfig(owner, repo),
    architectures: architectures,
    date: mostRecentReleaseDate(releases),
  };

  const entries = await buildReleaseEntries(packagesContentByArch, component);
  const releaseContent = generateReleaseFile(config, entries);

  // Only now swap in the Release/InRelease/Release.gpg that reference the
  // already-written blob hashes.
  await cache.setReleaseFile(owner, repo, releaseVariant, releaseContent);
  await cache.setReleaseIdsHash(owner, repo, releaseVariant, releaseHash);

  if (env.GPG_PRIVATE_KEY) {
    const inRelease = await signCleartext(releaseContent, env.GPG_PRIVATE_KEY, env.GPG_PASSPHRASE);
    await cache.setInReleaseFile(owner, repo, releaseVariant, inRelease);

    // Also cache Release.gpg for consistency
    const releaseGpg = await signDetached(releaseContent, env.GPG_PRIVATE_KEY, env.GPG_PASSPHRASE);
    await cache.setReleaseGpgSignature(owner, repo, releaseVariant, releaseGpg);
  }
}

/**
 * Handle Packages file request for a specific architecture.
 *
 * Served by looking up the current Release's SHA256 for this arch and
 * fetching the content-addressed blob. No separate mutable cache key is
 * written; this inherits the immutability of the blob cache (a concurrent
 * refresh producing a new Release with new blobs cannot corrupt an
 * in-flight client response).
 */
async function handlePackages(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  return servePackagesFromBlob(route, github, cache, env, ctx, false);
}

/**
 * Handle compressed Packages.gz request — same blob-lookup flow as
 * `handlePackages`, but pulls the pre-gzipped blob.
 */
async function handlePackagesGz(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  return servePackagesFromBlob(route, github, cache, env, ctx, true);
}

/**
 * Handle by-hash request — pure lookup against the content-addressed
 * `packages-blob/...` keyspace. Blobs are written before the (In)Release
 * that pins their SHA256 is written (see `generateAndCacheAll` and
 * `generateReleaseContent`), so a client that read any Release variant is
 * guaranteed to find the exact bytes referenced — even if a background
 * refresh has since produced a newer Release pinning different hashes.
 *
 * Returns 404 for unsupported hash types and for hashes that have aged out
 * of the blob cache (24h default TTL). No regeneration — we never fabricate
 * content for a hash that isn't in cache, since that would defeat the whole
 * point of content-addressing.
 */
async function handleByHash(
  route: RouteInfo,
  _github: GitHubClient,
  cache: CacheManager,
  _env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const { owner, repo, releaseVariant, hashType, hash } = route;

  if (!hashType || !hash) {
    return new Response('Invalid by-hash request', { status: 400 });
  }

  if (hashType !== 'SHA256') {
    return new Response(`Unsupported hash type: ${hashType}`, { status: 404 });
  }

  const cached = await cache.getPackagesBlob(owner, repo, releaseVariant, hash);
  if (!cached) {
    return new Response(`Hash not found: ${hash}`, { status: 404 });
  }

  return new Response(cached.body, {
    headers: {
      'Content-Type': cached.headers.get('Content-Type') || 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400', // content-addressed = immutable
    },
  });
}

/**
 * Parse a Release file's `SHA256:` section and return a map from path
 * (e.g. `main/binary-amd64/Packages`) to its SHA256 hex digest. Ignores
 * lines that don't match the expected `{32}sp {sha256} sp {size} sp {path}`
 * shape.
 */
function parseReleaseSha256Map(releaseContent: string): Map<string, string> {
  const lines = releaseContent.split('\n');
  const map = new Map<string, string>();
  let inSha256 = false;
  for (const line of lines) {
    if (/^SHA256:\s*$/.test(line)) { inSha256 = true; continue; }
    if (inSha256) {
      // Section continues until a non-indented line.
      if (!line.startsWith(' ')) { inSha256 = false; continue; }
      const match = line.trim().match(/^([0-9a-f]{64})\s+\d+\s+(\S.*)$/);
      if (match) map.set(match[2], match[1]);
    }
  }
  return map;
}

/**
 * Look up the SHA256 in a cached Release for a specific binary path under
 * the given component/architecture, e.g. `main/binary-amd64/Packages.gz`.
 */
function findPackagesSha(releaseContent: string, component: string, arch: string, gz: boolean): string | null {
  const suffix = gz ? '.gz' : '';
  const path = `${component}/binary-${arch}/Packages${suffix}`;
  return parseReleaseSha256Map(releaseContent).get(path) ?? null;
}

/**
 * Serve `binary-{arch}/Packages[.gz]` by looking up the SHA256 in the
 * current Release, then fetching the content-addressed blob. If the
 * Release isn't cached yet (cold start), generate it first — the
 * generator writes blobs before returning.
 *
 * Returns an empty body (not 404) when the repo has no releases or no
 * matching packages for the arch; apt clients follow up on Release, so a
 * 404 at this layer would mask useful Release-level errors.
 */
async function servePackagesFromBlob(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
  env: Env,
  ctx: ExecutionContext,
  gz: boolean
): Promise<Response> {
  const { owner, repo, component, architecture, releaseVariant } = route;
  const contentType = gz ? 'application/gzip' : 'text/plain';
  const emptyBody: BodyInit = gz ? await gzipCompress('') : '';
  const emptyHeaders = { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=300' };

  // Cached Release → parse → blob lookup. Kick off a background validation
  // so the next request sees fresh data.
  let releaseContent = await cache.getReleaseFile(owner, repo, releaseVariant);
  let refreshed = false;

  if (!releaseContent) {
    // Cold cache: generate Release (which also writes blobs) and cache it.
    try {
      releaseContent = await generateReleaseContent(route, github, cache, env, ctx);
      ctx.waitUntil(cache.setReleaseFile(owner, repo, releaseVariant, releaseContent));
      refreshed = true;
    } catch {
      return new Response(emptyBody, { headers: emptyHeaders });
    }
  }

  const findAndFetch = async (): Promise<Response | null> => {
    const sha = findPackagesSha(releaseContent!, component, architecture, gz);
    if (!sha) return null;
    const blob = await cache.getPackagesBlob(owner, repo, releaseVariant, sha);
    if (!blob) return null;
    return new Response(blob.body, {
      headers: {
        'Content-Type': blob.headers.get('Content-Type') || contentType,
        'Cache-Control': 'public, max-age=300',
      },
    });
  };

  let response = await findAndFetch();

  if (!response && !refreshed) {
    // Release is stale/points at evicted blobs. Regenerate once.
    try {
      releaseContent = await generateReleaseContent(route, github, cache, env, ctx);
      ctx.waitUntil(cache.setReleaseFile(owner, repo, releaseVariant, releaseContent));
      refreshed = true;
      response = await findAndFetch();
    } catch {
      return new Response(emptyBody, { headers: emptyHeaders });
    }
  }

  if (response) {
    if (!refreshed) ctx.waitUntil(validateAndRefreshCache(route, github, cache, env));
    return response;
  }

  // Release has no entry for this arch (no packages on this arch).
  return new Response(emptyBody, { headers: emptyHeaders });
}

/**
 * Generate packages content from multiple releases for aggregated assets
 */
async function generatePackagesContentMultiRelease(
  owner: string,
  repo: string,
  assets: GitHubAsset[],
  githubToken?: string
): Promise<PackageEntry[]> {
  // Build package entries with concurrency limiting to avoid subrequest limits
  // (Cloudflare Workers limits: 50 free tier, 1000 paid tier)
  return mapWithConcurrencyFiltered(
    assets,
    async (asset) => {
      try {
        return await buildPackageEntry(asset, githubToken);
      } catch (error) {
        console.error(`Failed to process ${asset.name}:`, error);
        return null;
      }
    },
    30 // Conservative concurrency limit for both tiers
  );
}

/**
 * Check if a GitHub download URL is publicly accessible (no auth required).
 * Uses a HEAD request to avoid downloading the full file.
 * Returns true for public repos, false for private repos requiring auth.
 */
async function isPubliclyAccessible(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
    });
    // 200 = accessible, 401/403 = requires auth
    return response.ok;
  } catch {
    // Network error - assume private to be safe
    return false;
  }
}

/**
 * Proxy a GitHub asset download, passing through the auth token.
 * This enables access to private repository assets where redirect would fail
 * (because the browser_download_url drops the Authorization header).
 */
async function proxyGitHubDownload(url: string, token: string): Promise<Response> {
  const response = await fetch(url, {
    headers: githubHeaders(token, 'octet-stream'),
    redirect: 'follow',
  });

  if (!response.ok) {
    return new Response(`Failed to fetch asset: ${response.status}`, { status: response.status });
  }

  // Stream the response through without buffering the entire file
  return new Response(response.body, {
    status: 200,
    headers: {
      'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Length': response.headers.get('Content-Length') || '',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

/**
 * Serve a GitHub asset - either redirect (public) or proxy (private).
 * Auto-detects repo privacy by checking if the URL is publicly accessible.
 */
async function serveAsset(url: string, token?: string): Promise<Response> {
  // Check if URL is publicly accessible (public repo)
  const isPublic = await isPubliclyAccessible(url);

  if (isPublic) {
    // Public repos: redirect to GitHub's CDN - offloads bandwidth from Worker
    return Response.redirect(url, 302);
  }

  // Private repos: proxy through Worker to pass auth token
  if (token) {
    return proxyGitHubDownload(url, token);
  }

  // Private repo but no token - can't access
  return new Response('Asset requires authentication', { status: 401 });
}

/**
 * Handle binary (.deb/.rpm) redirect to GitHub
 *
 * APT requests files using the Filename from the Packages file, which uses
 * pool-style paths: pool/main/h/hello/hello_1.0_amd64.deb
 *
 * We extract just the filename (last segment) and find the matching
 * GitHub release asset to redirect to. Uses cached URL when available,
 * otherwise searches across ALL releases.
 *
 * Auto-detects repo privacy: public repos get 302 redirect to GitHub's CDN,
 * private repos get proxied through the Worker with authentication.
 */
async function handleBinaryRedirect(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
  env: Env,
  packageType: 'deb' | 'rpm' = 'deb'
): Promise<Response> {
  const { owner, repo, filename, releaseVariant } = route;
  const typeName = packageType === 'deb' ? 'Asset' : 'RPM package';

  try {
    // Try to get cached release hash first - if it exists, we can check asset URL cache
    const cachedReleaseHash = await cache.getReleaseIdsHash(owner, repo, releaseVariant);
    if (cachedReleaseHash) {
      const cachedUrl = await cache.getAssetUrl(owner, repo, filename, releaseVariant, cachedReleaseHash);
      if (cachedUrl) {
        return serveAsset(cachedUrl, env.GITHUB_TOKEN);
      }
    }

    // Cache miss or no release hash - fetch releases and search for the asset
    const includePrerelease = releaseVariant === 'prerelease';
    const releases = await github.getAllReleases(owner, repo, includePrerelease);

    if (releases.length === 0) {
      return new Response(`${typeName} not found: ${filename}`, { status: 404 });
    }

    const releaseHash = await computeReleaseIdsHash(releases);

    for (const release of releases) {
      const asset = release.assets.find(a => a.name === filename);
      if (asset) {
        // Cache the URL for next time (keyed by release hash for auto-invalidation)
        await cache.setAssetUrl(owner, repo, filename, releaseVariant, releaseHash, asset.browser_download_url);
        return serveAsset(asset.browser_download_url, env.GITHUB_TOKEN);
      }
    }

    return new Response(`${typeName} not found: ${filename}`, { status: 404 });
  } catch (error) {
    console.error(`${typeName} redirect failed:`, error);
    return new Response(`${typeName} not found`, { status: 404 });
  }
}

// =============================================================================
// RPM Repository Handlers
// =============================================================================

type RpmXmlKind = 'primary' | 'filelists' | 'other';

/**
 * A fully-built RPM metadata snapshot: the repomd.xml plus every blob it
 * references, content-addressed by SHA256. Everything in here is internally
 * consistent — repomd.xml's checksums match the blob bodies exactly.
 */
interface RpmSnapshot {
  repomdXml: string;
  signature: string | null;
  releaseIdsHash: string;
  // Map from sha256 -> { body, contentType } for all six files:
  //   {primaryXml, primaryGz, filelistsXml, filelistsGz, otherXml, otherGz}
  blobs: Map<string, { body: Uint8Array; contentType: string }>;
  hashes: RepomdHashes;
}

/**
 * Build RPM package entries from assets
 */
async function buildRpmPackages(
  assets: GitHubAsset[],
  githubToken?: string
): Promise<RpmPackageEntry[]> {
  const rpmAssets = filterRpmAssets(assets);

  // Build RPM entries with concurrency limiting to avoid subrequest limits
  // (Cloudflare Workers limits: 50 free tier, 1000 paid tier)
  return mapWithConcurrencyFiltered(
    rpmAssets,
    async (asset) => {
      try {
        return await buildRpmPackageEntry(asset, githubToken);
      } catch (error) {
        console.error(`Failed to process ${asset.name}:`, error);
        return null;
      }
    },
    30
  );
}

/**
 * Build a complete, internally-consistent RPM metadata snapshot from scratch.
 * Hits GitHub for releases and parses RPM headers. Does not touch the cache.
 */
async function buildRpmSnapshot(
  route: RouteInfo,
  github: GitHubClient,
  env: Env
): Promise<RpmSnapshot | null> {
  const { owner, repo, releaseVariant } = route;
  const includePrerelease = releaseVariant === 'prerelease';
  const releases = await github.getAllReleases(owner, repo, includePrerelease);

  if (releases.length === 0) return null;

  const releaseIdsHash = await computeReleaseIdsHash(releases);
  const allAssets = aggregateAssets(releases);
  const packages = await buildRpmPackages(allAssets, env.GITHUB_TOKEN);

  const primaryXml = generatePrimaryXml(packages);
  const filelistsXml = generateFilelistsXml(packages);
  const otherXml = generateOtherXml(packages);

  const [primaryGz, filelistsGz, otherGz] = await Promise.all([
    gzipCompress(primaryXml),
    gzipCompress(filelistsXml),
    gzipCompress(otherXml),
  ]);

  // Fall back to current time if every release happens to have a null
  // published_at (possible if all were demoted to drafts between pages).
  const timestamp = mostRecentReleaseTimestamp(releases);

  const { xml: repomdXml, hashes } = await buildRepomd({
    primary: { xml: primaryXml, gz: primaryGz },
    filelists: { xml: filelistsXml, gz: filelistsGz },
    other: { xml: otherXml, gz: otherGz },
    timestamp,
  });

  const signature = env.GPG_PRIVATE_KEY
    ? await signDetachedBinary(repomdXml, env.GPG_PRIVATE_KEY, env.GPG_PASSPHRASE)
    : null;

  const textBytes = (s: string) => new TextEncoder().encode(s);
  const blobs = new Map<string, { body: Uint8Array; contentType: string }>();
  blobs.set(hashes.primary.xml,   { body: textBytes(primaryXml),   contentType: 'application/xml' });
  blobs.set(hashes.primary.gz,    { body: primaryGz,               contentType: 'application/gzip' });
  blobs.set(hashes.filelists.xml, { body: textBytes(filelistsXml), contentType: 'application/xml' });
  blobs.set(hashes.filelists.gz,  { body: filelistsGz,             contentType: 'application/gzip' });
  blobs.set(hashes.other.xml,     { body: textBytes(otherXml),     contentType: 'application/xml' });
  blobs.set(hashes.other.gz,      { body: otherGz,                 contentType: 'application/gzip' });

  return { repomdXml, signature, releaseIdsHash, blobs, hashes };
}

/**
 * Persist a snapshot to cache. Writes blobs before repomd.xml so any client
 * that subsequently reads the cached repomd.xml can resolve every hashed
 * <location> path from the blob cache.
 */
async function cacheRpmSnapshot(
  route: RouteInfo,
  cache: CacheManager,
  snapshot: RpmSnapshot
): Promise<void> {
  const { owner, repo, releaseVariant } = route;

  // Write all blobs first. They are content-addressed and immutable.
  await Promise.all(
    Array.from(snapshot.blobs.entries()).map(([sha256, { body, contentType }]) =>
      cache.setRpmBlob(owner, repo, releaseVariant, sha256, body, contentType)
    )
  );

  // Then swap in the repomd.xml (and its signature) that references them.
  const repomdWrites: Promise<void>[] = [
    cache.setRpmRepomd(owner, repo, releaseVariant, snapshot.repomdXml),
    cache.setReleaseIdsHash(owner, repo, releaseVariant, snapshot.releaseIdsHash),
  ];
  if (snapshot.signature) {
    repomdWrites.push(cache.setRpmRepomdAsc(owner, repo, releaseVariant, snapshot.signature));
  }
  await Promise.all(repomdWrites);
}

/**
 * Background task: if the release-ids-hash has changed, rebuild the snapshot
 * and write it. Blob cache keys are content-addressed so this never
 * invalidates in-flight references from clients holding the previous
 * repomd.xml — they continue to resolve against the older immutable blobs
 * (until the blob TTL expires, 24h by default).
 */
async function validateAndRefreshRpmSnapshot(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
  env: Env
): Promise<void> {
  try {
    const { owner, repo, releaseVariant } = route;
    const includePrerelease = releaseVariant === 'prerelease';
    const releases = await github.getAllReleases(owner, repo, includePrerelease);
    if (releases.length === 0) return;

    const currentHash = await computeReleaseIdsHash(releases);
    if (!(await cache.needsRefresh(owner, repo, releaseVariant, currentHash))) return;

    const snapshot = await buildRpmSnapshot(route, github, env);
    if (!snapshot) return;
    await cacheRpmSnapshot(route, cache, snapshot);
  } catch (error) {
    console.error('Background RPM snapshot refresh failed:', error);
  }
}

/**
 * Get or generate the current repomd.xml + signature. Serves from cache
 * when present and kicks off background validation; otherwise builds a
 * fresh snapshot and caches it.
 */
async function getRepomdWithSignature(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
  env: Env,
  ctx: ExecutionContext
): Promise<{ repomd: string; signature: string | null }> {
  const { owner, repo, releaseVariant } = route;

  const [cachedRepomd, cachedSignature] = await Promise.all([
    cache.getRpmRepomd(owner, repo, releaseVariant),
    cache.getRpmRepomdAsc(owner, repo, releaseVariant),
  ]);

  if (cachedRepomd && (cachedSignature || !env.GPG_PRIVATE_KEY)) {
    ctx.waitUntil(validateAndRefreshRpmSnapshot(route, github, cache, env));
    return { repomd: cachedRepomd, signature: cachedSignature };
  }

  const snapshot = await buildRpmSnapshot(route, github, env);
  if (!snapshot) {
    // No releases — return an empty repomd.xml so DNF doesn't error out.
    const empty = await buildRepomd({
      primary:   { xml: generatePrimaryXml([]),   gz: await gzipCompress(generatePrimaryXml([])) },
      filelists: { xml: generateFilelistsXml([]), gz: await gzipCompress(generateFilelistsXml([])) },
      other:     { xml: generateOtherXml([]),     gz: await gzipCompress(generateOtherXml([])) },
      timestamp: Math.floor(Date.now() / 1000),
    });
    return { repomd: empty.xml, signature: null };
  }

  ctx.waitUntil(cacheRpmSnapshot(route, cache, snapshot));
  return { repomd: snapshot.repomdXml, signature: snapshot.signature };
}

/**
 * Handle repomd.xml request
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
 * Handle repomd.xml.asc request
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
 * Handle RPM XML metadata requests.
 *
 * - Hashed paths (`{sha256}-primary.xml.gz` etc.): look up blob by hash.
 *   On miss, rebuild current snapshot; if the hash matches a current blob,
 *   serve and cache it. Otherwise 404.
 * - Unhashed paths: regenerate current state and serve on the fly.
 *   These are only hit by legacy clients or direct-URL debugging; current
 *   repomd.xml always emits hashed paths.
 */
async function handleRpmXml(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
  env: Env,
  ctx: ExecutionContext,
  xmlType: RpmXmlKind,
  compressed: boolean
): Promise<Response> {
  const { owner, repo, releaseVariant, hash } = route;
  const contentType = compressed ? 'application/gzip' : 'application/xml';

  if (hash) {
    const cached = await cache.getRpmBlob(owner, repo, releaseVariant, hash);
    if (cached) {
      return new Response(cached.body, {
        headers: {
          'Content-Type': cached.headers.get('Content-Type') || contentType,
          'Cache-Control': 'public, max-age=86400', // content-addressed = immutable
        },
      });
    }

    // Cache miss. Rebuild and serve only if the requested hash matches a
    // current blob — this prevents serving bogus content for an old hash.
    const snapshot = await buildRpmSnapshot(route, github, env);
    if (snapshot) {
      const blob = snapshot.blobs.get(hash);
      if (blob) {
        ctx.waitUntil(cacheRpmSnapshot(route, cache, snapshot));
        return new Response(blob.body, {
          headers: {
            'Content-Type': blob.contentType,
            'Cache-Control': 'public, max-age=86400',
          },
        });
      }
    }

    return new Response(`Metadata file not found: ${hash}`, { status: 404 });
  }

  // Unhashed legacy path: regenerate on the fly.
  const snapshot = await buildRpmSnapshot(route, github, env);
  const emptyBody = (): Uint8Array => new TextEncoder().encode(
    xmlType === 'primary' ? generatePrimaryXml([]) :
    xmlType === 'filelists' ? generateFilelistsXml([]) :
    generateOtherXml([])
  );

  if (!snapshot) {
    const body = compressed ? await gzipCompress(emptyBody()) : emptyBody();
    return new Response(body, {
      headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=300' },
    });
  }

  const selectedHash = compressed
    ? snapshot.hashes[xmlType].gz
    : snapshot.hashes[xmlType].xml;
  const blob = snapshot.blobs.get(selectedHash);

  ctx.waitUntil(cacheRpmSnapshot(route, cache, snapshot));

  return new Response(blob!.body, {
    headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=300' },
  });
}
