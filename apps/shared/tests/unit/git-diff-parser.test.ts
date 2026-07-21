import { describe, expect, it } from 'bun:test';
import { parseGitDiff } from '@mangostudio/shared/git';

describe('Git diff parser', () => {
  it('parses multiple hunks with old and new line numbers', () => {
    const hunks = parseGitDiff(
      [
        'diff --git a/src/file.ts b/src/file.ts',
        '--- a/src/file.ts',
        '+++ b/src/file.ts',
        '@@ -1,3 +1,3 @@ export function value() {',
        ' const before = 1;',
        '-return before;',
        '+return before + 1;',
        ' }',
        '@@ -10 +10,2 @@',
        '-old();',
        '+newCall();',
        '+notify();',
        '\\ No newline at end of file',
      ].join('\n')
    );

    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 });
    expect(hunks[0]?.lines).toEqual([
      { type: 'context', content: 'const before = 1;', oldLine: 1, newLine: 1 },
      { type: 'deletion', content: 'return before;', oldLine: 2 },
      { type: 'addition', content: 'return before + 1;', newLine: 2 },
      { type: 'context', content: '}', oldLine: 3, newLine: 3 },
    ]);
    expect(hunks[1]?.lines.at(-1)).toEqual({
      type: 'metadata',
      content: '\\ No newline at end of file',
    });
  });

  it('returns no hunks for binary and empty diffs', () => {
    expect(parseGitDiff('')).toEqual([]);
    expect(parseGitDiff('Binary files a/image.png and b/image.png differ')).toEqual([]);
  });
});
