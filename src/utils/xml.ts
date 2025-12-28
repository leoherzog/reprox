/**
 * XML utilities for Reprox
 */

/**
 * Escape special XML characters and remove invalid XML 1.0 control characters.
 * XML 1.0 valid chars: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
 * Invalid: 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F
 */
export function escapeXml(str: string): string {
  // First remove invalid XML 1.0 control characters
  // Keep: \t (0x09), \n (0x0A), \r (0x0D)
  // Remove: 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F
  const sanitized = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

  // Then escape XML entities
  return sanitized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
