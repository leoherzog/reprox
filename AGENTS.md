# AGENTS.md

This file provides guidance to AI Agents like Claude, Gemini, Codex, and others when working with code in this repository.

## Project Overview

Reprox is a serverless APT/RPM repository gateway that transforms GitHub Releases into fully compliant package repositories on-the-fly. It runs on Cloudflare Workers, uses HTTP Range Requests to extract only package headers (avoiding full downloads), and caches metadata using the Workers Cache API.

**Key Features:**
- Serves packages from **all GitHub releases** (not just the latest)
- Supports **prerelease variant** via `/prerelease` path segment
- Only includes packages with valid **SHA256 digests** (GitHub added this feature in June 2025)
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

### Key Types

**RouteInfo** (`src/types.ts`) - Parsed URL information:
- `owner`, `repo` - GitHub repository
- `releaseVariant` - `'stable'` (default) or `'prerelease'`
- `type` - Route type (inrelease, packages, binary, repomd, rpm-binary, etc.)

**AggregatedAsset** (`src/types.ts`) - Asset with release context:
- Extends `GitHubAsset` with `releaseTagName` and `releaseId`
- Used to track which release each package came from

### Key Modules

**Parsers** (`src/parsers/`)
- `ar.ts` - AR archive format (container for .deb files)
- `tar.ts` - TAR archive format (contains control files)
- `deb.ts` - Debian package metadata extraction
- `rpm.ts` - RPM header parsing with binary tag structure

**Generators** (`src/generators/`)
- `packages.ts` - APT Packages file generation, `filterDebAssets()` (requires valid digest)
- `release.ts` - APT Release/InRelease generation
- `repodata.ts` - RPM primary.xml, filelists.xml, other.xml generation, `filterRpmAssets()` (requires valid digest)

**Utilities** (`src/utils/`)
- `crypto.ts` - SHA256 hashing and gzip compression (Web Crypto API)
- `streams.ts` - Stream reading utilities (`readStreamToBuffer`, `concatUint8Arrays`)
- `architectures.ts` - Architecture detection from filenames (Debian and RPM)
- `xml.ts` - XML escaping and control character sanitization (removes invalid XML 1.0 chars)

**Other**
- `src/signing/gpg.ts` - OpenPGP signing (cleartext and detached)
- `src/github/api.ts` - GitHub API client with `getAllReleases()` pagination
- `src/cache/cache.ts` - Cache API wrapper with variant-aware keys
- `src/lib/xz.ts` - XZ decompression wrapper for Workers (see below)

### Design Patterns

**Multi-Release Aggregation:**
- `getAllReleases()` fetches all releases with pagination (`per_page=100`, max 50 pages = 5,000 releases)
- `aggregateAssets()` flattens assets from all releases with release context
- Prerelease filtering: `includePrerelease` parameter controls whether to include prereleases

**Digest Filtering:**
- GitHub added SHA256 digests to release assets in June 2025
- `filterDebAssets()` and `filterRpmAssets()` only include packages with valid `digest` field
- Older releases without digests are excluded (package managers require valid checksums)

**Cache Strategy:**
- All cache keys include `variant` (stable/prerelease) for isolation
- Release IDs hash (`computeReleaseIdsHash()`) detects when releases change
- Asset URLs are cached for efficient binary redirects
- Background validation refreshes cache without blocking requests

**Range Requests:** Only fetches package headers to minimize bandwidth (64KB for .deb, 256KB for .rpm)

**Architecture Detection:** Parses architecture from filename patterns
- Debian: amd64, arm64, i386, armhf, all
- RPM: x86_64, aarch64, i686, noarch

### Cache Keys

All cache keys include the release variant for proper isolation:

| Type | Key Pattern |
|------|-------------|
| APT Packages | `packages/{variant}/{owner}/{repo}/{arch}` |
| APT Release | `release/{variant}/{owner}/{repo}` |
| APT InRelease | `inrelease/{variant}/{owner}/{repo}` |
| Release IDs Hash | `release-ids-hash/{variant}/{owner}/{repo}` |
| Asset URL | `asset-url/{variant}/{owner}/{repo}/{filename}` |
| RPM Primary | `rpm/primary/{variant}/{owner}/{repo}` |
| RPM Repomd | `rpm/repomd/{variant}/{owner}/{repo}` |

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
- `GITHUB_TOKEN` - GitHub personal access token for higher API rate limits (recommended for multi-release pagination)
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
| `GITHUB_TOKEN` | Recommended | GitHub PAT for higher API rate limits |

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

All derived artifacts (InRelease, Release.gpg, repomd.xml) are generated and cached together to ensure checksums match. The gzip compression uses consistent output to avoid checksum mismatches between cached repomd.xml and served .xml.gz files.
