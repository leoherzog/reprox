# AGENTS.md

This file provides guidance to AI Agents like Claude, Gemini, Codex, and others when working with code in this repository.

## Project Overview

Reprox is a serverless APT/RPM repository gateway that transforms GitHub Releases into fully compliant package repositories on-the-fly. It runs on Cloudflare Workers, uses HTTP Range Requests to extract only package headers (avoiding full downloads), and caches metadata using the Workers Cache API.

## Common Commands

```bash
npm run dev          # Start local development server (wrangler dev)
npm run deploy       # Deploy to Cloudflare Workers
npm run test         # Run tests with vitest
npm run typecheck    # TypeScript type checking (tsc --noEmit)
```

## Architecture

### Request Flow
1. **Entry Point** (`src/index.ts`) - Routes requests based on URL pattern, validates GitHub owner/repo naming
2. **GitHub Client** (`src/github/api.ts`) - Fetches latest release info via GitHub API
3. **Parsers** (`src/parsers/`) - Extract package metadata using Range Requests (64KB for .deb, 256KB for .rpm)
4. **Generators** (`src/generators/`) - Generate repository metadata files (Packages, Release, repomd.xml, etc.)
5. **Cache** (`src/cache/cache.ts`) - Cache API-based caching with release ID validation for freshness

### URL Routes
- **APT**: `/{owner}/{repo}/dists/{dist}/InRelease`, `/{owner}/{repo}/pool/.../*.deb`
- **RPM**: `/{owner}/{repo}/repodata/repomd.xml`, `/{owner}/{repo}/Packages/*.rpm`
- **Common**: `/{owner}/{repo}/public.key`

### Key Modules

**Parsers** (`src/parsers/`)
- `ar.ts` - AR archive format (container for .deb files)
- `tar.ts` - TAR archive format (contains control files)
- `deb.ts` - Debian package metadata extraction
- `rpm.ts` - RPM header parsing with binary tag structure

**Generators** (`src/generators/`)
- `packages.ts` - APT Packages file generation
- `release.ts` - APT Release/InRelease generation
- `repodata.ts` - RPM primary.xml, filelists.xml, other.xml generation

**Utilities** (`src/utils/`)
- `crypto.ts` - SHA256 hashing and gzip compression (Web Crypto API)
- `streams.ts` - Stream reading utilities (`readStreamToBuffer`, `concatUint8Arrays`)
- `architectures.ts` - Architecture detection from filenames (Debian and RPM)
- `xml.ts` - XML escaping and control character sanitization (removes invalid XML 1.0 chars)

**Other**
- `src/signing/gpg.ts` - OpenPGP signing (cleartext and detached)
- `src/github/api.ts` - GitHub API client for release info
- `src/cache/cache.ts` - Cache API wrapper with release ID validation
- `src/lib/xz.ts` - XZ decompression wrapper for Workers (see below)

### Design Patterns
- **Range Requests**: Only fetches package headers to minimize bandwidth
- **Release ID Caching**: Cache invalidation triggered by new GitHub releases
- **Architecture Detection**: Parses architecture from filename patterns
  - Debian: amd64, arm64, i386, armhf, all
  - RPM: x86_64, aarch64, i686, noarch

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
- `GITHUB_TOKEN` - GitHub personal access token for higher API rate limits
- `CACHE_TTL` - Cache TTL in seconds for content (default: 86400). Release IDs use a 5-minute TTL for freshness checks.

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

   A GitHub personal access token increases API rate limits from 60 to 5,000 requests/hour:

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
