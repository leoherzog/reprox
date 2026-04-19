# AGENTS.md

This file provides guidance to AI Agents like Claude, Gemini, Codex, and others when working with code in this repository.

## Project Overview

Reprox is a serverless APT/RPM repository gateway that transforms GitHub Releases into fully compliant package repositories on-the-fly. It runs on Cloudflare Workers, uses HTTP Range Requests to extract only package headers (avoiding full downloads), and caches metadata using the Workers Cache API.

**Key Features:**
- Serves packages from **all GitHub releases** (not just the latest)
- Supports **prerelease variant** via `/prerelease` path segment
- **Private repository support** with auto-detection (proxies downloads with auth)
- Only includes packages with valid **SHA256 digests** (GitHub added this feature in June 2025)
- Excludes **draft releases** (identified by `published_at === null`)
- Uses **pagination** with `per_page=100` (up to 5,000 releases max)

## Common Commands

```bash
npm run dev          # Start local development server (wrangler dev)
npm run deploy       # Deploy to Cloudflare Workers
npm run test         # Run tests with vitest
npm run typecheck    # TypeScript type checking (tsc --noEmit)
```

## Architecture

### Request Flow
1. **Entry Point** (`src/index.ts`) - Routes requests based on URL pattern, detects prerelease variant
2. **GitHub Client** (`src/github/api.ts`) - Fetches all releases with pagination via `getAllReleases()`
3. **Asset Aggregation** - Combines assets from all releases into a unified package list
4. **Parsers** (`src/parsers/`) - Extract package metadata using Range Requests (64KB for .deb, 256KB for .rpm)
5. **Generators** (`src/generators/`) - Generate repository metadata files (Packages, Release, repomd.xml, etc.)
6. **Cache** (`src/cache/cache.ts`) - Cache API with release IDs hash validation for freshness

### URL Routes

**Standard (excludes prereleases):**
- **APT**: `/{owner}/{repo}/dists/{dist}/InRelease`, `/{owner}/{repo}/pool/.../*.deb`
- **RPM**: `/{owner}/{repo}/repodata/repomd.xml`, `/{owner}/{repo}/Packages/*.rpm`
- **Common**: `/{owner}/{repo}/public.key`

**Prerelease Variant (includes all releases):**
- **APT**: `/{owner}/{repo}/prerelease/dists/{dist}/InRelease`, etc.
- **RPM**: `/{owner}/{repo}/prerelease/repodata/repomd.xml`, etc.
- **Common**: `/{owner}/{repo}/prerelease/public.key`

**Internal API (for landing page search box):**
- `/_/search?q={query}` - Proxies GitHub repository search with authenticated token and Cache API caching (5 min TTL)
- `/_/package?owner={owner}&repo={repo}` - Extracts package name from latest release `.deb`/`.rpm` asset filenames, cached (5 min TTL)

### Key Types

**RouteInfo** (`src/types.ts`) - Parsed URL information:
- `owner`, `repo` - GitHub repository
- `releaseVariant` - `'stable'` (default) or `'prerelease'`
- `type` - Route type (inrelease, packages, binary, repomd, rpm-binary, etc.)

**GitHubRelease** (`src/types.ts`) - Release metadata:
- `published_at` is `string | null` - null indicates a draft release (excluded from processing)

### Key Modules

**Parsers** (`src/parsers/`)
- `ar.ts` - AR archive format (container for .deb files)
- `tar.ts` - TAR archive format (contains control files)
- `deb.ts` - Debian package metadata extraction
- `rpm.ts` - RPM header parsing with binary tag structure

**Generators** (`src/generators/`)
- `packages.ts` - APT Packages file generation, `filterDebAssets()` (requires valid digest)
- `release.ts` - APT Release/InRelease generation
- `repodata.ts` - RPM primary.xml, filelists.xml, other.xml generation. `buildRepomd()` emits repomd.xml with hash-prefixed `<location>` paths and returns the per-section SHA256s so callers can key blob writes. `filterRpmAssets()` enforces valid digests.

**Utilities** (`src/utils/`)
- `crypto.ts` - SHA256 hashing and gzip compression (Web Crypto API)
- `streams.ts` - Stream reading utilities (`readStreamToBuffer`, `concatUint8Arrays`)
- `architectures.ts` - Architecture detection from filenames (Debian and RPM)
- `xml.ts` - XML escaping and control character sanitization (removes invalid XML 1.0 chars)
- `concurrency.ts` - Concurrency-limited Promise execution (`mapWithConcurrency`, `mapWithConcurrencyFiltered`) to avoid Cloudflare subrequest limits

**Other**
- `src/signing/gpg.ts` - OpenPGP signing (cleartext and detached)
- `src/github/api.ts` - GitHub API client with `getAllReleases()` pagination
- `src/cache/cache.ts` - Cache API wrapper with variant-aware keys
- `src/lib/xz.ts` - XZ decompression wrapper for Workers (see below)

**Landing Page** (`scripts/build-readme.ts` → `src/generated/readme-html.ts`)
- Build script reads `README.md`, renders to HTML via `marked` with syntax highlighting, inlines and optimizes all CSS (PurgeCSS + cssnano), and exports a static HTML string
- Injects an interactive search box after the "Usage" heading that lets visitors search for GitHub repos and auto-fill `{owner}`, `{repo}`, `{package}` placeholders throughout the page
- The search box CSS uses `github-markdown-css` v5 custom properties for automatic dark mode; semantic HTML (`<strong>`, `<small>`, `<a>`) leverages upstream styles where possible
- Client-side JS uses `TreeWalker` for text node replacement (preserves DOM/event listeners) and `display: none` to hide instruction comments when a repo is selected
- All CSS classes used by the search box must appear in the `searchBoxSkeleton` variable so PurgeCSS preserves them
- The `/_/search` and `/_/package` endpoints in `src/index.ts` proxy GitHub API calls server-side using `GITHUB_TOKEN` for higher rate limits, with Cache API caching

### Design Patterns

**Multi-Release Aggregation:**
- `getAllReleases()` fetches all releases with pagination (`per_page=100`, max 50 pages = 5,000 releases)
- `aggregateAssets()` flattens assets from all releases with release context
- Draft filtering: releases with `published_at === null` are always excluded
- Prerelease filtering: `includePrerelease` parameter controls whether to include prereleases

**Private Repository Support:**
- Auto-detects repo privacy using HEAD request to check URL accessibility
- Public repos: 302 redirect to GitHub's CDN (offloads bandwidth)
- Private repos: Proxies download through Worker with `Authorization: token` header
- Requires `GITHUB_TOKEN` for private repo access

**Digest Filtering:**
- GitHub added SHA256 digests to release assets in June 2025
- `filterDebAssets()` and `filterRpmAssets()` only include packages with valid `digest` field
- Older releases without digests are excluded (package managers require valid checksums)

**Cache Strategy:**
- All cache keys include `variant` (stable/prerelease) for isolation
- `computeReleaseIdsHash()` (async) computes SHA256 of release IDs + asset digests for cache invalidation
- Asset URLs are cached for efficient binary redirects
- Background validation refreshes cache without blocking requests
- RPM metadata files (primary/filelists/other, both .xml and .xml.gz) are stored as **content-addressed blobs** keyed by their SHA256. `repomd.xml` references them via `<location href="repodata/{sha256}-primary.xml.gz"/>` (Fedora's `unique_md_filenames` convention). Blobs are immutable — a client holding any historical `repomd.xml` resolves its references against the exact bytes that were hashed into it, eliminating the race where background refresh could update `primary.xml.gz` between a client's `repomd.xml` fetch and its follow-up fetches.

**Concurrency Limiting:**
- Cloudflare Workers has subrequest limits (50 free tier, 1000 paid)
- `mapWithConcurrencyFiltered()` processes assets with limited parallelism (default: 30)
- Prevents hitting subrequest limits when processing many packages

**Range Requests:** Only fetches package headers to minimize bandwidth (64KB for .deb, 256KB for .rpm)

**Architecture Detection:** Parses architecture from filename patterns
- Debian: amd64, arm64, i386, armhf, all
- RPM: x86_64, aarch64, i686, noarch

### Cache Keys

All cache keys include the release variant for proper isolation:

| Type | Key Pattern |
|------|-------------|
| APT Packages Blob (content-addressed; backs both by-hash and legacy URLs) | `packages-blob/{variant}/{owner}/{repo}/{sha256}` |
| APT Release | `release/{variant}/{owner}/{repo}` |
| APT InRelease | `inrelease/{variant}/{owner}/{repo}` |
| APT Release.gpg | `release-gpg/{variant}/{owner}/{repo}` |
| Release IDs Hash | `release-ids-hash/{variant}/{owner}/{repo}` |
| Asset URL | `asset-url/{variant}/{owner}/{repo}/{releaseHash}/{filename}` |
| RPM Repomd | `rpm/repomd/{variant}/{owner}/{repo}` |
| RPM Repomd.asc | `rpm/repomd-asc/{variant}/{owner}/{repo}` |
| RPM Blob (content-addressed) | `rpm/blob/{variant}/{owner}/{repo}/{sha256}` |

The legacy `binary-{arch}/Packages[.gz]` URL has no dedicated mutable key — `handlePackages`/`handlePackagesGz` parses the current cached `Release`, extracts the SHA256 for the requested path, and serves the content-addressed blob. This inherits the blob cache's immutability: a concurrent refresh producing a newer Release cannot corrupt in-flight client responses.

### Cloudflare Workers Considerations

**Static WASM Imports**: Workers blocks dynamic `WebAssembly.instantiate()` for security (similar to `eval()`). WASM modules must be imported statically at build time.

**Compression Support**: .deb control archives can use different compression formats:
- `control.tar.gz` - gzip (most common, native DecompressionStream)
- `control.tar.xz` - XZ (uses xzwasm with static WASM import)
- `control.tar.zst` - Zstandard (uses fzstd library)
- `control.tar` - uncompressed

**XZ WASM Handling** (`src/lib/xz.ts`): The xzwasm library embeds WASM as base64 and uses dynamic instantiation, which doesn't work in Workers. Our solution:
1. `scripts/extract-xz-wasm.cjs` extracts the WASM binary from xzwasm on `npm install` (postinstall hook)
2. `src/lib/xz.ts` imports the WASM statically and patches `XzReadableStream._moduleInstance` before use
3. The extracted `src/lib/xz-decompress.wasm` is gitignored (auto-generated)

If xzwasm is updated, running `npm install` will automatically extract the new WASM version.

## Environment Variables

Optional secrets (set via `wrangler secret put`):
- `GPG_PRIVATE_KEY` - Armored GPG private key for repository signing (public key is auto-extracted)
- `GPG_PASSPHRASE` - Passphrase for encrypted GPG private keys (optional, only needed if key is passphrase-protected)
- `GPG_PUBLIC_KEY` - Armored GPG public key (optional override, normally extracted from private key)
- `GITHUB_TOKEN` - GitHub personal access token for higher API rate limits and private repository access
- `CACHE_TTL` - Cache TTL in seconds for content (default: 86400). Release IDs hash uses a 5-minute TTL for freshness checks.

## Testing

Tests use Vitest with `@cloudflare/vitest-pool-workers` to run in a Workers-like environment. Test files are in `test/` directory.

```bash
npm run test                    # Run all tests
npx vitest run parsers.test.ts  # Run specific test file
npx vitest --watch              # Watch mode

# Run with integration tests (requires GitHub token for API access)
GITHUB_TOKEN=<token> RUN_INTEGRATION_TESTS=true npm test
```

Integration tests in `test/integration/` fetch real packages from GitHub releases to verify parsing works with actual .deb and .rpm files.

## Deployment

### Prerequisites

- Node.js 18.0.0 or higher
- A Cloudflare account (free tier works)
- `wrangler` CLI (installed via npm as a dev dependency)
- (Optional) GPG for generating signing keys

### Step-by-Step Deployment

1. **Clone and install dependencies**

   ```bash
   git clone https://github.com/leoherzog/reprox.git
   cd reprox
   npm install
   ```

   The `postinstall` script automatically extracts the XZ WASM binary from xzwasm for static import (required for Cloudflare Workers).

2. **Authenticate with Cloudflare**

   ```bash
   npx wrangler login
   ```

   This opens a browser for OAuth authentication with your Cloudflare account.

3. **Configure worker name (optional)**

   Edit `wrangler.toml` to customize the worker name:
   ```toml
   name = "my-reprox-instance"
   ```

   Default name is `reprox`. The worker will be accessible at `https://{name}.{account-subdomain}.workers.dev`.

4. **Generate and configure GPG signing key**

   Repositories should be GPG-signed for package manager verification:

   ```bash
   # Generate a new GPG key (no passphrase for simplicity, or use one)
   gpg --quick-gen-key "My Reprox Instance" rsa4096 sign never

   # Export and set as secret
   gpg --armor --export-secret-keys "My Reprox Instance" | npx wrangler secret put GPG_PRIVATE_KEY

   # If your key has a passphrase, also set it
   npx wrangler secret put GPG_PASSPHRASE
   ```

   Alternatively, import an existing key:
   ```bash
   cat /path/to/private-key.asc | npx wrangler secret put GPG_PRIVATE_KEY
   ```

5. **Configure GitHub token (recommended)**

   A GitHub personal access token increases API rate limits from 60 to 5,000 requests/hour. This is especially important for repositories with lots of Releases, given many API calls and pagination:

   ```bash
   npx wrangler secret put GITHUB_TOKEN
   ```

   Create a token at https://github.com/settings/tokens with no special permissions (public repo access only).

6. **Deploy to Cloudflare Workers**

   ```bash
   npm run deploy
   ```

   The CLI outputs the worker URL upon successful deployment.

### Secrets Reference

Set secrets using `npx wrangler secret put <NAME>`:

| Secret | Required | Description |
|--------|----------|-------------|
| `GPG_PRIVATE_KEY` | Recommended | ASCII-armored GPG private key for repository signing |
| `GPG_PASSPHRASE` | If key is encrypted | Passphrase for the GPG private key |
| `GPG_PUBLIC_KEY` | No | Override auto-extracted public key (rarely needed) |
| `GITHUB_TOKEN` | Recommended | GitHub PAT for higher API rate limits and private repo access |

### Environment Variables

Set in `wrangler.toml` under `[vars]`:

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHE_TTL` | `86400` | Cache TTL in seconds for repository content (24 hours) |

### Custom Domain Setup

1. Add a custom domain in Cloudflare Workers dashboard → your worker → Triggers → Custom Domains
2. Or use `wrangler.toml`:
   ```toml
   routes = [
     { pattern = "packages.example.com/*", zone_name = "example.com" }
   ]
   ```

### Verifying Deployment

Test that the worker is running:

```bash
# Should return usage instructions
curl https://your-worker.workers.dev/

# Test a real repository (replace with an actual GitHub repo with .deb/.rpm releases)
curl https://your-worker.workers.dev/{owner}/{repo}/public.key
curl https://your-worker.workers.dev/{owner}/{repo}/dists/stable/InRelease

# Test prerelease variant (includes prereleases)
curl https://your-worker.workers.dev/{owner}/{repo}/prerelease/dists/stable/InRelease
```

### Updating

```bash
git pull
npm install        # Re-extracts WASM if xzwasm updated
npm run deploy
```

### Local Development

```bash
npm run dev        # Starts local dev server with wrangler
npm run test       # Run test suite
npm run typecheck  # TypeScript type checking
```

## Important Implementation Notes

### Digest Requirement

GitHub added SHA256 digests to release assets in June 2025. Packages from older releases that lack digests are **excluded** from the repository because package managers (apt, dnf) require valid checksums. This is intentional - there's no way to verify package integrity without checksums.

### Pagination Limits

The `getAllReleases()` function has a `MAX_PAGES = 50` limit to prevent infinite loops and API exhaustion. With `per_page=100`, this allows up to 5,000 releases per repository.

### Cache Consistency

Metadata files containing checksums (Release, InRelease, repomd.xml) reference other files (Packages, primary.xml, etc.). Sequential client fetches — DNF does `repomd.xml` → `primary.xml.gz` → packages — must see a consistent snapshot, or the client will reject a checksum mismatch.

**APT**: `Acquire-By-Hash: yes` is advertised in `Release`, and Packages files (both uncompressed and `.gz`) are stored as **immutable, content-addressed blobs** under `packages-blob/{variant}/{owner}/{repo}/{sha256}`. `handleByHash` is a pure cache lookup — given a hash pinned by any (In)Release a client holds, it returns the exact bytes that were hashed, or 404 if the blob has aged out. `generateAndCacheAll()` and `generateReleaseContent()` write these blobs BEFORE writing the (In)Release/Release.gpg that reference them, so any client reading a cached Release can always resolve every by-hash URL. The legacy non-by-hash URL `binary-{arch}/Packages[.gz]` is served the same way: `handlePackages`/`handlePackagesGz` parses the current cached Release, extracts the path's SHA256, and returns the blob — so non-by-hash clients see a fresh-Release-matching body as well. There is no separate mutable `packages/.../{arch}` key.

**RPM**: Uses Fedora's `unique_md_filenames` convention — `repomd.xml` references `repodata/{sha256}-primary.xml.gz` (and filelists/other). The XML files are stored as **immutable, content-addressed blobs** under `rpm/blob/{variant}/{owner}/{repo}/{sha256}`, so any `repomd.xml` a client holds (stale or fresh) resolves to the exact bytes that were hashed into it. `buildRpmSnapshot()` generates everything from scratch in one pass; `cacheRpmSnapshot()` writes blobs before `repomd.xml` so references are always resolvable.

**Stale-While-Revalidate**: The cache uses a stale-while-revalidate pattern — cached content is returned immediately while freshness is validated in background. For RPM (always), APT by-hash, and APT non-by-hash (because the legacy URL also serves via blob lookup against the current Release) this is race-free by construction: blobs are content-addressed and immutable, and every path pinned by a Release exists before the Release itself is written. The only remaining race is the normal one inherent to stale-while-revalidate: a client can fetch Release v1, then fetch Packages after the server has refreshed to v2. Under `Acquire-By-Hash` (default `yes` in apt ≥ 1.2, released April 2016) the client uses the v1 hash and gets v1 bytes; non-by-hash clients get v2 bytes (matching v2's current Release, not v1's) and will pick up v2 on their next refresh round. For immediate invalidation, use `?cache=false`.

**Why this matters (the bug this design fixes)**: before content-addressing, a DNF update fetching a repo immediately after a new GitHub release could get a stale `repomd.xml` referencing v1 checksums, then follow up with `primary.xml.gz` after the background refresh had already written v2 bytes under the same URL. DNF would compute the v2 checksum, compare against v1, and fail with `Downloading successful, but checksum doesn't match`. The APT analogue was `Hash Sum mismatch` — a client reads cached `InRelease` v1 (pinning v1 `Packages` SHA256), the background refresh rewrites the mutable `packages/.../{arch}` key with v2 bytes, then the client fetches the Packages file and apt computes v2's SHA256 against v1's pin and aborts. Hashed filenames + immutable blobs (RPM `rpm/blob/...`, APT `packages-blob/...`) make both races impossible. The mutable `packages/.../{arch}` key has been eliminated entirely: the legacy non-by-hash URL now serves the same content-addressed blob that `handleByHash` does, resolved by reading the current Release's SHA256 — so even a non-by-hash client sees a self-consistent `(Release, Packages)` snapshot per request.
