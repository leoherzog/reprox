import type { Env, RouteInfo, PackageEntry, RpmPackageEntry, GitHubRelease, AggregatedAsset } from './types';
import { GitHubClient, getArchitecturesFromAssets } from './github/api';
import { CacheManager, createCacheManager, computeReleaseIdsHash, type ReleaseVariant } from './cache/cache';
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

      // Handle root path - serve README from GitHub with dynamic replacements
      if (url.pathname === '/') {
        const cache = createCacheManager(env.CACHE_TTL);
        if (url.searchParams.get('cache') === 'false') {
          await cache.clearReadme();
        }
        return handleReadme(request, url, cache, env, ctx);
      }

      // Handle favicon request
      if (url.pathname === '/favicon.ico' || url.pathname === '/favicon.svg') {
        return handleFavicon();
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
          return handleBinaryRedirect(route, github, cache);

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
          return handleBinaryRedirect(route, github, cache, 'rpm');

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
    const repodataRoutes: Record<string, RouteInfo['type']> = {
      'repomd.xml': 'repomd',
      'repomd.xml.asc': 'repomd-asc',
      'primary.xml': 'primary',
      'primary.xml.gz': 'primary-gz',
      'filelists.xml': 'filelists',
      'filelists.xml.gz': 'filelists-gz',
      'other.xml': 'other',
      'other.xml.gz': 'other-gz',
    };
    const routeType = repodataRoutes[p(3)];
    if (routeType) {
      route.type = routeType;
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
 * Aggregate assets from multiple releases into a single array with release context
 */
function aggregateAssets(releases: GitHubRelease[]): AggregatedAsset[] {
  return releases.flatMap(release =>
    release.assets.map(asset => ({
      ...asset,
      releaseTagName: release.tag_name,
      releaseId: release.id,
    }))
  );
}

// GitHub raw URL for the README
const README_RAW_URL = 'https://raw.githubusercontent.com/leoherzog/reprox/main/README.md';

/**
 * Handle root path request - fetch and serve README from GitHub
 * with dynamic baseUrl and fingerprint replacements
 */
async function handleReadme(
  request: Request,
  url: URL,
  cache: CacheManager,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
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

  // Check cache for raw README
  let rawReadme = await cache.getReadme();

  if (!rawReadme) {
    // Fetch from GitHub
    try {
      const response = await fetch(README_RAW_URL);
      if (!response.ok) {
        return new Response('Failed to fetch README from GitHub', { status: 502 });
      }
      rawReadme = await response.text();

      // Cache the raw README in background
      ctx.waitUntil(cache.setReadme(rawReadme));
    } catch (error) {
      console.error('Failed to fetch README:', error);
      return new Response('Failed to fetch README from GitHub', { status: 502 });
    }
  }

  // Apply dynamic replacements
  let content = rawReadme;

  // Replace all instances of https://reprox.dev with current baseUrl
  content = content.replace(/https:\/\/reprox\.dev/g, baseUrl);

  // Replace fingerprint placeholder with actual fingerprint
  if (fingerprint) {
    content = content.replace(
      /# Verify the instance's fingerprint by browsing to it in your web browser/g,
      `# This instance's fingerprint: ${fingerprint}`
    );
  } else {
    // Remove the fingerprint comment lines if no key is configured
    content = content.replace(/# Verify the instance's fingerprint by browsing to it in your web browser\n/g, '');
  }

  // Check if browser wants HTML
  const acceptHeader = request.headers.get('Accept') || '';
  const wantsHtml = acceptHeader.includes('text/html');

  if (wantsHtml) {
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Reprox</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@latest/github-markdown.min.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@latest/styles/github.min.css" media="(prefers-color-scheme: light)">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@latest/styles/github-dark.min.css" media="(prefers-color-scheme: dark)">
  <style>
    .markdown-body {
      box-sizing: border-box;
      min-width: 200px;
      max-width: 980px;
      margin: 0 auto;
      padding: 45px;
    }
    @media (max-width: 767px) {
      .markdown-body { padding: 15px; }
    }
  </style>
</head>
<body class="markdown-body">
  <div id="content"></div>
  <script src="https://cdn.jsdelivr.net/npm/marked@latest/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/marked-gfm-heading-id@latest/lib/index.umd.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/marked-alert@latest/dist/index.umd.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@latest/highlight.min.js"></script>
  <script>
    marked.use(markedGfmHeadingId.gfmHeadingId());
    marked.use(markedAlert());
    document.getElementById('content').innerHTML = marked.parse(${JSON.stringify(content)});
    hljs.highlightAll();
  </script>
</body>
</html>`;
    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
    });
  }

  return new Response(content, {
    status: 200,
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
  ctx.waitUntil(cache.setInReleaseFile(owner, repo, releaseVariant, response));

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
    ctx.waitUntil(validateAndRefreshCache(route, github, cache, env, ctx));
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
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  try {
    const { owner, repo, releaseVariant } = route;
    const includePrerelease = releaseVariant === 'prerelease';
    const releases = await github.getAllReleases(owner, repo, includePrerelease);

    if (releases.length === 0) return;

    const currentHash = computeReleaseIdsHash(releases);
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
 * Generate Release file content with entries for ALL architectures
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

  // Populate map and cache results
  for (const result of archResults) {
    if (result) {
      packagesContentByArch.set(result.arch, result.content);
      ctx.waitUntil(cache.setPackagesFile(owner, repo, result.arch, releaseVariant, result.content));
    }
  }

  // Build Release config with detected architectures and most recent release timestamp
  const config = {
    ...defaultReleaseConfig(owner, repo),
    architectures: architectures,
    date: new Date(releases[0].published_at), // Most recent release
  };

  // Build entries for all architectures
  const entries = await buildReleaseEntries(packagesContentByArch, component);

  // Update cache metadata with release IDs hash
  const releaseIdsHash = computeReleaseIdsHash(releases);
  ctx.waitUntil(cache.setReleaseIdsHash(owner, repo, releaseVariant, releaseIdsHash));

  return generateReleaseFile(config, entries);
}

/**
 * Generate and cache all repository metadata
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
  const releaseHash = computeReleaseIdsHash(releases);

  // Aggregate assets from all releases
  const allAssets = aggregateAssets(releases);

  // Cache all asset URLs for efficient binary redirects (keyed by release hash for auto-invalidation)
  await cache.setAssetUrls(owner, repo, releaseVariant, releaseHash, allAssets);

  const debAssets = filterDebAssets(allAssets);
  const architectures = getArchitecturesFromAssets(debAssets);
  const packagesContentByArch = new Map<string, string>();

  // Generate and cache Packages content for all architectures in parallel
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

  // Populate map and cache results
  await Promise.all(
    archResults
      .filter((result): result is { arch: string; content: string } => result !== null)
      .map(async ({ arch, content }) => {
        packagesContentByArch.set(arch, content);
        await cache.setPackagesFile(owner, repo, arch, releaseVariant, content);
      })
  );

  const config = {
    ...defaultReleaseConfig(owner, repo),
    architectures: architectures,
    date: new Date(releases[0].published_at), // Most recent release
  };

  const entries = await buildReleaseEntries(packagesContentByArch, component);
  const releaseContent = generateReleaseFile(config, entries);

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
  const { owner, repo, architecture, releaseVariant } = route;

  // Check cache first
  const cachedHash = await cache.getReleaseIdsHash(owner, repo, releaseVariant);
  if (cachedHash) {
    const cached = await cache.getPackagesFile(owner, repo, architecture, releaseVariant);
    if (cached) {
      // Validate in background
      ctx.waitUntil(validateAndRefreshCache(route, github, cache, env, ctx));
      return cached;
    }
  }

  // Generate fresh packages content
  const includePrerelease = releaseVariant === 'prerelease';
  const releases = await github.getAllReleases(owner, repo, includePrerelease);

  if (releases.length === 0) {
    return ''; // No packages available
  }

  // Aggregate assets from all releases
  const allAssets = aggregateAssets(releases);
  const debAssets = filterDebAssets(allAssets);
  const archAssets = filterByArchitecture(debAssets, architecture);

  const packages = await generatePackagesContentMultiRelease(
    owner,
    repo,
    archAssets,
    env.GITHUB_TOKEN
  );

  const content = generatePackagesFile(packages);

  // Cache in background
  const releaseIdsHash = computeReleaseIdsHash(releases);
  ctx.waitUntil(
    Promise.all([
      cache.setPackagesFile(owner, repo, architecture, releaseVariant, content),
      cache.setReleaseIdsHash(owner, repo, releaseVariant, releaseIdsHash),
    ])
  );

  return content;
}

/**
 * Generate packages content from multiple releases for aggregated assets
 */
async function generatePackagesContentMultiRelease(
  owner: string,
  repo: string,
  assets: AggregatedAsset[],
  githubToken?: string
): Promise<PackageEntry[]> {
  // Build package entries in parallel (fetches metadata via Range requests)
  const entries = await Promise.all(
    assets.map(async (asset) => {
      try {
        return await buildPackageEntry(asset, owner, repo, asset.releaseTagName, githubToken);
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
 * Handle binary (.deb/.rpm) redirect to GitHub
 *
 * APT requests files using the Filename from the Packages file, which uses
 * pool-style paths: pool/main/h/hello/hello_1.0_amd64.deb
 *
 * We extract just the filename (last segment) and find the matching
 * GitHub release asset to redirect to. Uses cached URL when available,
 * otherwise searches across ALL releases.
 */
async function handleBinaryRedirect(
  route: RouteInfo,
  github: GitHubClient,
  cache: CacheManager,
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
        return Response.redirect(cachedUrl, 302);
      }
    }

    // Cache miss or no release hash - fetch releases and search for the asset
    const includePrerelease = releaseVariant === 'prerelease';
    const releases = await github.getAllReleases(owner, repo, includePrerelease);

    if (releases.length === 0) {
      return new Response(`${typeName} not found: ${filename}`, { status: 404 });
    }

    const releaseHash = computeReleaseIdsHash(releases);

    for (const release of releases) {
      const asset = release.assets.find(a => a.name === filename);
      if (asset) {
        // Cache the URL for next time (keyed by release hash for auto-invalidation)
        await cache.setAssetUrl(owner, repo, filename, releaseVariant, releaseHash, asset.browser_download_url);
        // 302 redirect to GitHub's CDN - offloads bandwidth from Worker
        return Response.redirect(asset.browser_download_url, 302);
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
  const { owner, repo, releaseVariant } = route;

  // Check cache first
  const [cachedRepomd, cachedSignature] = await Promise.all([
    cache.getRpmRepomd(owner, repo, releaseVariant),
    cache.getRpmRepomdAsc(owner, repo, releaseVariant),
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
      cache.setRpmRepomd(owner, repo, releaseVariant, repomdXml),
      signature ? cache.setRpmRepomdAsc(owner, repo, releaseVariant, signature) : Promise.resolve(),
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
    const { owner, repo, releaseVariant } = route;
    const includePrerelease = releaseVariant === 'prerelease';
    const releases = await github.getAllReleases(owner, repo, includePrerelease);

    if (releases.length === 0) return;

    const currentHash = computeReleaseIdsHash(releases);
    const needsRefresh = await cache.needsRefresh(owner, repo, releaseVariant, currentHash);

    if (needsRefresh) {
      // Regenerate repomd and signature
      const files = await getRpmMetadataFiles(route, github, cache, env, ctx);
      const repomdXml = await generateRepomdXml(files);

      const cachePromises: Promise<void>[] = [
        cache.setRpmRepomd(owner, repo, releaseVariant, repomdXml),
        cache.setReleaseIdsHash(owner, repo, releaseVariant, currentHash),
      ];

      if (env.GPG_PRIVATE_KEY) {
        const signature = await signDetachedBinary(repomdXml, env.GPG_PRIVATE_KEY, env.GPG_PASSPHRASE);
        cachePromises.push(cache.setRpmRepomdAsc(owner, repo, releaseVariant, signature));
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
  const { owner, repo, releaseVariant } = route;

  // Check cache first
  const cachedHash = await cache.getReleaseIdsHash(owner, repo, releaseVariant);
  if (cachedHash) {
    const [cachedPrimary, cachedFilelists, cachedOther, cachedTimestamp] = await Promise.all([
      cache.getRpmPrimaryXml(owner, repo, releaseVariant),
      cache.getRpmFilelistsXml(owner, repo, releaseVariant),
      cache.getRpmOtherXml(owner, repo, releaseVariant),
      cache.getRpmTimestamp(owner, repo, releaseVariant),
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
  const includePrerelease = releaseVariant === 'prerelease';
  const releases = await github.getAllReleases(owner, repo, includePrerelease);

  if (releases.length === 0) {
    // Return empty metadata if no releases
    return {
      primaryXml: generatePrimaryXml([]),
      filelistsXml: generateFilelistsXml([]),
      otherXml: generateOtherXml([]),
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  // Aggregate assets from all releases
  const allAssets = aggregateAssets(releases);
  const packages = await buildRpmPackages(allAssets, env.GITHUB_TOKEN);
  const metadata = generateRpmXmlMetadata(packages);

  // Use most recent release's timestamp
  const timestamp = Math.floor(new Date(releases[0].published_at).getTime() / 1000);
  const releaseIdsHash = computeReleaseIdsHash(releases);

  // Cache in background (including asset URLs for efficient binary redirects)
  ctx.waitUntil(
    Promise.all([
      cache.setRpmPrimaryXml(owner, repo, releaseVariant, metadata.primaryXml),
      cache.setRpmFilelistsXml(owner, repo, releaseVariant, metadata.filelistsXml),
      cache.setRpmOtherXml(owner, repo, releaseVariant, metadata.otherXml),
      cache.setRpmTimestamp(owner, repo, releaseVariant, timestamp),
      cache.setReleaseIdsHash(owner, repo, releaseVariant, releaseIdsHash),
      cache.setAssetUrls(owner, repo, releaseVariant, releaseIdsHash, allAssets),
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
    const { owner, repo, releaseVariant } = route;
    const includePrerelease = releaseVariant === 'prerelease';
    const releases = await github.getAllReleases(owner, repo, includePrerelease);

    if (releases.length === 0) return;

    const currentHash = computeReleaseIdsHash(releases);
    const needsRefresh = await cache.needsRefresh(owner, repo, releaseVariant, currentHash);

    if (needsRefresh) {
      // Aggregate assets from all releases
      const allAssets = aggregateAssets(releases);
      const packages = await buildRpmPackages(allAssets, env.GITHUB_TOKEN);
      const metadata = generateRpmXmlMetadata(packages);
      const timestamp = Math.floor(new Date(releases[0].published_at).getTime() / 1000);

      await Promise.all([
        cache.setRpmPrimaryXml(owner, repo, releaseVariant, metadata.primaryXml),
        cache.setRpmFilelistsXml(owner, repo, releaseVariant, metadata.filelistsXml),
        cache.setRpmOtherXml(owner, repo, releaseVariant, metadata.otherXml),
        cache.setRpmTimestamp(owner, repo, releaseVariant, timestamp),
        cache.setReleaseIdsHash(owner, repo, releaseVariant, currentHash),
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
