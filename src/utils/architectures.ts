/**
 * Architecture detection utilities for Reprox
 *
 * Provides functions to detect package architecture from filenames
 * for both Debian (.deb) and RPM (.rpm) package formats.
 */

/**
 * Determine architecture from Debian package filename.
 * Used to categorize .deb files by target architecture.
 */
export function extractArchFromFilename(filename: string): string {
  const patterns: [RegExp, string][] = [
    [/[_.-](amd64|x86_64|x64)[_.-]/i, 'amd64'],
    [/[_.-](arm64|aarch64)[_.-]/i, 'arm64'],
    [/[_.-](i386|i686|x86)[_.-](?!64)/i, 'i386'],
    [/[_.-](armhf|armv7)[_.-]/i, 'armhf'],
    [/[_.-]all[_.-]/i, 'all'],
  ];

  for (const [pattern, arch] of patterns) {
    if (pattern.test(filename)) {
      return arch;
    }
  }

  // Default to amd64 if no pattern matches
  return 'amd64';
}

/**
 * Determine architecture from RPM package filename.
 * RPM filenames follow the pattern: name-version-release.arch.rpm
 */
export function extractRpmArchFromFilename(filename: string): string {
  // RPM filenames: name-version-release.arch.rpm
  const match = filename.match(/\.([^.]+)\.rpm$/);
  if (match) {
    const arch = match[1];
    // Normalize architecture names
    if (arch === 'x86_64' || arch === 'amd64') return 'x86_64';
    if (arch === 'aarch64' || arch === 'arm64') return 'aarch64';
    if (arch === 'i686' || arch === 'i386') return 'i686';
    if (arch === 'noarch') return 'noarch';
    return arch;
  }
  return 'x86_64';
}
