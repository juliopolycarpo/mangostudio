import { describe, expect, test } from 'bun:test';

import { normalizeChangelogSeparators } from '../lib/changelog';
import { PROTOCOL_CHANGELOG } from '../lib/protocol';
import { readText } from './support/read-text';

describe('committed historical changelog separators', () => {
  for (const file of ['CHANGELOG.md', PROTOCOL_CHANGELOG]) {
    test(`${file} separates each historical release from the preceding bullet`, () => {
      expect(
        [...readText(file).matchAll(/^- .+\r?\n## \[[^\]]+\] - \d{4}-\d{2}-\d{2}$/gm)].map(
          ([seam]) => seam
        )
      ).toEqual([]);
    });
  }
});

describe('normalizeChangelogSeparators', () => {
  for (const newline of ['\n', '\r\n']) {
    test(`inserts only a missing separator and preserves ${JSON.stringify(newline)} line endings`, () => {
      const before = [
        '# Changelog',
        '',
        '## [0.1.1] - 2026-07-05',
        '',
        '- First entry',
        '## [0.1.0-canary] - 2026-06-15',
        '',
        '- Older entry',
      ].join(newline);
      const after = before.replace(
        `${newline}## [0.1.0-canary]`,
        `${newline}${newline}## [0.1.0-canary]`
      );
      expect(normalizeChangelogSeparators(before)).toBe(after);
      expect(normalizeChangelogSeparators(after)).toBe(after);
      // Every original nonblank line, heading, date and bullet stays identical.
      expect(after.split(newline).filter(Boolean)).toEqual(before.split(newline).filter(Boolean));
    });
  }

  test('preserves already separated sections, extra blank lines and EOF', () => {
    for (const source of [
      '',
      '- Entry\n\n## [1.0.0] - 2026-01-01\n',
      '- Entry\n\n\n## [1.0.0] - 2026-01-01',
      '- Entry\n## Other heading\n',
      '- Entry\n## [Unreleased]\n',
    ]) {
      expect(normalizeChangelogSeparators(source)).toBe(source);
    }
  });

  test('leaves fenced examples unchanged, including shorter nested fence markers', () => {
    for (const marker of ['````', '~~~~']) {
      const example = `${marker}markdown\n${marker.slice(0, 3)}\n- Example\n## [1.0.0] - 2026-01-01\n${marker}\n`;
      const actual = '- Real entry\n## [0.1.0] - 2025-01-01\n';
      expect(normalizeChangelogSeparators(example + actual)).toBe(
        example + actual.replace('\n##', '\n\n##')
      );
    }
  });

  test('the committed historical files are fixed points', () => {
    for (const file of ['CHANGELOG.md', PROTOCOL_CHANGELOG]) {
      const source = readText(file);
      expect(normalizeChangelogSeparators(source)).toBe(source);
    }
  });
});
