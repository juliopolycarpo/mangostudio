import { describe, expect, it } from 'bun:test';
import { parseGitDiff } from '@mangostudio/shared/git';

const TWO_HUNKS = [
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
];

describe('Git diff parser', () => {
  it('parses multiple hunks with old and new line numbers', () => {
    const hunks = parseGitDiff(TWO_HUNKS.join('\n'));

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

  it('ends a hunk at its header counts, not at the trailing newline', () => {
    // `git diff` output ends in a newline; the empty string after it used to
    // become a phantom context row numbered one past the hunk.
    const hunks = parseGitDiff(['@@ -1,2 +1 @@', '-first', '-second', '+only', ''].join('\n'));

    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.lines).toEqual([
      { type: 'deletion', content: 'first', oldLine: 1 },
      { type: 'deletion', content: 'second', oldLine: 2 },
      { type: 'addition', content: 'only', newLine: 1 },
    ]);
  });

  it('parses the same hunks whether or not the diff ends in a newline', () => {
    expect(parseGitDiff(`${TWO_HUNKS.join('\n')}\n`)).toEqual(parseGitDiff(TWO_HUNKS.join('\n')));
  });

  it('reads an empty line inside the counts as blank context', () => {
    const hunks = parseGitDiff(['@@ -1,3 +1,3 @@', ' a', '', ' b', ''].join('\n'));

    expect(hunks[0]?.lines).toEqual([
      { type: 'context', content: 'a', oldLine: 1, newLine: 1 },
      { type: 'context', content: '', oldLine: 2, newLine: 2 },
      { type: 'context', content: 'b', oldLine: 3, newLine: 3 },
    ]);
  });

  it("ignores the next file's headers after a hunk is complete", () => {
    const hunks = parseGitDiff(
      [
        '@@ -1 +1 @@',
        '-a',
        '+b',
        '\\ No newline at end of file',
        'diff --git a/other.ts b/other.ts',
        'index 1234567..89abcde 100644',
        '--- a/other.ts',
        '+++ b/other.ts',
        '@@ -5 +5 @@',
        '-c',
        '+d',
        '',
      ].join('\n')
    );

    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.lines.map((line) => line.type)).toEqual(['deletion', 'addition', 'metadata']);
    expect(hunks[1]?.lines).toEqual([
      { type: 'deletion', content: 'c', oldLine: 5 },
      { type: 'addition', content: 'd', newLine: 5 },
    ]);
  });

  it('returns no hunks for binary and empty diffs', () => {
    expect(parseGitDiff('')).toEqual([]);
    expect(parseGitDiff('Binary files a/image.png and b/image.png differ')).toEqual([]);
  });
});
