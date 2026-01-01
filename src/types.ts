/**
 * Environment bindings for Cloudflare Worker
 */
export interface Env {
  GPG_PRIVATE_KEY?: string;
  GPG_PASSPHRASE?: string;
  GPG_PUBLIC_KEY?: string;
  GITHUB_TOKEN?: string;
  CACHE_TTL?: string;
}

/**
 * Parsed route information
 */
export interface RouteInfo {
  owner: string;
  repo: string;
  distribution: string;
  component: string;
  architecture: string;
  filename: string;
  hashType?: string;  // For by-hash routes: SHA256, SHA512, etc.
  hash?: string;      // The actual hash value
  releaseVariant: 'stable' | 'prerelease';  // Whether to include prerelease versions
  type:
    | 'packages' | 'packages-gz' | 'release' | 'release-gpg' | 'inrelease'
    | 'by-hash'
    | 'repomd' | 'repomd-asc' | 'primary' | 'primary-gz' | 'filelists' | 'filelists-gz' | 'other' | 'other-gz'
    | 'binary' | 'rpm-binary' | 'public-key' | 'unknown';
}

/**
 * GitHub Release information
 */
export interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string;
  body: string;
  published_at: string;
  prerelease: boolean;
  assets: GitHubAsset[];
}

/**
 * GitHub Asset information
 */
export interface GitHubAsset {
  id: number;
  name: string;
  size: number;
  browser_download_url: string;
  content_type: string;
  digest?: string; // SHA256 digest in format "sha256:..."
}

/**
 * Extracted Debian package control metadata
 */
export interface DebianControlData {
  package: string;
  version: string;
  architecture: string;
  maintainer: string;
  installedSize: number;
  depends: string;
  recommends: string;
  suggests: string;
  conflicts: string;
  replaces: string;
  provides: string;
  section: string;
  priority: string;
  homepage: string;
  description: string;
}

/**
 * Single package entry for Packages file
 */
export interface PackageEntry {
  controlData: DebianControlData;
  filename: string;
  size: number;
  sha256: string;
  md5sum: string;
}

/**
 * AR archive file entry
 */
export interface ArEntry {
  name: string;
  timestamp: number;
  ownerId: number;
  groupId: number;
  mode: number;
  size: number;
  offset: number;
}

/**
 * TAR archive file entry
 */
export interface TarEntry {
  name: string;
  size: number;
  data: Uint8Array;
}

/**
 * RPM changelog entry
 */
export interface RpmChangelogEntry {
  time: number;
  author: string;
  text: string;
}

/**
 * Extracted RPM package header metadata
 */
export interface RpmHeaderData {
  name: string;
  version: string;
  release: string;
  epoch: number;
  summary: string;
  description: string;
  arch: string;
  license: string;
  group: string;
  url: string;
  vendor: string;
  packager: string;
  buildTime: number;
  sourceRpm: string;
  installedSize: number; // Size when installed (from RPMTAG_SIZE)
  requires: string[];
  provides: string[];
  conflicts: string[];
  obsoletes: string[];
  // File list data
  files: string[];
  // Changelog data
  changelog: RpmChangelogEntry[];
}

/**
 * RPM package entry for repodata
 */
export interface RpmPackageEntry {
  headerData: RpmHeaderData;
  filename: string;
  size: number;
  checksum: string;
  checksumType: string;
}

/**
 * Minimal asset type for filtering (subset of GitHubAsset)
 */
export type AssetLike = { name: string; size: number; browser_download_url: string; digest?: string };

/**
 * Asset with release context for multi-release aggregation
 */
export interface AggregatedAsset extends GitHubAsset {
  releaseTagName: string;
  releaseId: number;
}
