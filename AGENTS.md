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
- `xml.ts` - XML character escaping

**Other**
- `src/signing/gpg.ts` - OpenPGP signing (cleartext and detached)
- `src/github/api.ts` - GitHub API client for release info
- `src/cache/cache.ts` - Cache API wrapper with release ID validation
- `src/lib/xz.ts` - XZ decompression wrapper for Workers (see below)

### Design Patterns
- **Range Requests**: Only fetches package headers to minimize bandwidth
- **Release ID Caching**: Cache invalidation triggered by new GitHub releases
- **Architecture Detection**: Parses architecture from filename patterns (amd64, arm64, i386, armhf, all)

### Cloudflare Workers Considerations

**Static WASM Imports**: Workers blocks dynamic `WebAssembly.instantiate()` for security (similar to `eval()`). WASM modules must be imported statically at build time.

**XZ Decompression** (`src/lib/xz.ts`): Some .deb packages use `control.tar.xz` compression. The xzwasm library embeds WASM as base64 and uses dynamic instantiation, which doesn't work in Workers. Our solution:
1. `scripts/extract-xz-wasm.cjs` extracts the WASM binary from xzwasm on `npm install` (postinstall hook)
2. `src/lib/xz.ts` imports the WASM statically and patches `XzReadableStream._moduleInstance` before use
3. The extracted `src/lib/xz-decompress.wasm` is gitignored (auto-generated)

If xzwasm is updated, running `npm install` will automatically extract the new WASM version.

## Environment Variables

Optional secrets (set via `wrangler secret put`):
- `GPG_PRIVATE_KEY` - Armored GPG private key for repository signing (public key is auto-extracted)
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
