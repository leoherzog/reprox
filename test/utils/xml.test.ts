import { describe, it, expect } from 'vitest';
import { escapeXml } from '../../src/utils/xml';

// ============================================================================
// escapeXml Tests
// ============================================================================

describe('escapeXml', () => {
  describe('XML entity escaping', () => {
    it('escapes ampersands', () => {
      expect(escapeXml('Tom & Jerry')).toBe('Tom &amp; Jerry');
    });

    it('escapes less-than signs', () => {
      expect(escapeXml('a < b')).toBe('a &lt; b');
    });

    it('escapes greater-than signs', () => {
      expect(escapeXml('a > b')).toBe('a &gt; b');
    });

    it('escapes double quotes', () => {
      expect(escapeXml('say "hello"')).toBe('say &quot;hello&quot;');
    });

    it('escapes single quotes (apostrophes)', () => {
      expect(escapeXml("it's fine")).toBe('it&apos;s fine');
    });

    it('escapes multiple entities in one string', () => {
      expect(escapeXml('<tag attr="value">a & b</tag>'))
        .toBe('&lt;tag attr=&quot;value&quot;&gt;a &amp; b&lt;/tag&gt;');
    });

    it('handles strings with no special characters', () => {
      expect(escapeXml('hello world')).toBe('hello world');
    });

    it('handles empty strings', () => {
      expect(escapeXml('')).toBe('');
    });
  });

  describe('invalid XML 1.0 control character removal', () => {
    it('removes null bytes (0x00)', () => {
      expect(escapeXml('hello\x00world')).toBe('helloworld');
    });

    it('removes control characters 0x01-0x08', () => {
      expect(escapeXml('a\x01b\x02c\x03d\x04e\x05f\x06g\x07h\x08i'))
        .toBe('abcdefghi');
    });

    it('removes vertical tab (0x0B)', () => {
      expect(escapeXml('hello\x0Bworld')).toBe('helloworld');
    });

    it('removes form feed (0x0C)', () => {
      expect(escapeXml('hello\x0Cworld')).toBe('helloworld');
    });

    it('removes control characters 0x0E-0x1F', () => {
      expect(escapeXml('a\x0Eb\x0Fc\x10d\x1Fe'))
        .toBe('abcde');
    });

    it('preserves tab (0x09)', () => {
      expect(escapeXml('hello\tworld')).toBe('hello\tworld');
    });

    it('preserves newline (0x0A)', () => {
      expect(escapeXml('hello\nworld')).toBe('hello\nworld');
    });

    it('preserves carriage return (0x0D)', () => {
      expect(escapeXml('hello\rworld')).toBe('hello\rworld');
    });

    it('handles mixed valid whitespace and entities', () => {
      expect(escapeXml('line1\nline2\t<tag>'))
        .toBe('line1\nline2\t&lt;tag&gt;');
    });
  });

  describe('combined scenarios', () => {
    it('handles control characters followed by entities', () => {
      expect(escapeXml('\x00<script>'))
        .toBe('&lt;script&gt;');
    });

    it('handles real-world RPM description with special chars', () => {
      const description = 'This package provides C++ bindings (libstdc++)';
      expect(escapeXml(description))
        .toBe('This package provides C++ bindings (libstdc++)');
    });

    it('handles package names with version constraints', () => {
      const depends = 'libc6 (>= 2.17)';
      expect(escapeXml(depends))
        .toBe('libc6 (&gt;= 2.17)');
    });

    it('handles URLs in package metadata', () => {
      const url = 'https://example.com/path?foo=bar&baz=qux';
      expect(escapeXml(url))
        .toBe('https://example.com/path?foo=bar&amp;baz=qux');
    });

    it('handles multiline descriptions with special characters', () => {
      const description = 'Summary: A <cool> package\n\nFeatures:\n- Fast & reliable\n- "Easy" to use';
      expect(escapeXml(description))
        .toBe('Summary: A &lt;cool&gt; package\n\nFeatures:\n- Fast &amp; reliable\n- &quot;Easy&quot; to use');
    });
  });

  describe('unicode handling', () => {
    it('preserves valid unicode characters', () => {
      expect(escapeXml('Hello 世界')).toBe('Hello 世界');
    });

    it('preserves emoji characters', () => {
      expect(escapeXml('Package 📦 ready')).toBe('Package 📦 ready');
    });

    it('preserves accented characters', () => {
      expect(escapeXml('café résumé')).toBe('café résumé');
    });
  });
});
