import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { blankNonCode } from '../../support/blank-non-code';
import { scanSourcePaths } from '../../support/source-scan';

const TESTS_ROOT = join(import.meta.dir, '../..');

/**
 * Files that may remove a directory tree themselves, each with the reason it cannot use
 * `removeFixtureDir` / `removeFixtureDirSync` (`tests/support/remove-fixture-dir.ts`).
 */
const ALLOWED_RECURSIVE_REMOVALS: Readonly<Record<string, string>> = {
  'support/remove-fixture-dir.ts': 'the helper itself',
  'support/github-fixture-cleanup.ts': 'the retry loop the helper delegates to',
  'unit/server/frontend-zero-inode.test.ts':
    'removes through the unmocked `node:fs` it keeps, because the helper would resolve the test mock',
  'unit/server/frontend-static-fs-calls.test.ts':
    'removes through the unmocked `node:fs` it keeps, because the helper would resolve the test mock',
  'unit/server/frontend-file-identity.test.ts':
    'removes through the unmocked `node:fs` it keeps, because the helper would resolve the test mock',
  'unit/server/frontend-build-state-case.test.ts':
    'removes through the unmocked `node:fs` it keeps, because the helper would resolve the test mock',
};

/** A call of `rm`, `rmSync`, `rmdir`, `rmdirSync` or `rimraf`, bare or as a member (`fs.rmSync(`). */
const REMOVAL_CALL = /(?<![\w$])(?:rm|rmSync|rmdir|rmdirSync|rimraf)\s*\(/g;

/** The argument text of the call whose `(` is at `open - 1`, on blanked code. */
function argumentsOf(code: string, open: number): string {
  let depth = 1;
  let index = open;
  while (index < code.length && depth > 0) {
    if (code[index] === '(') depth++;
    else if (code[index] === ')') depth--;
    index++;
  }
  return code.slice(open, index - 1);
}

/**
 * The 1-based lines of every removal call that asks for a recursive removal. Strings and
 * comments are blanked first, so a `'rm -rf'` literal or a doc comment does not count.
 *
 * @example
 * recursiveRemovalLines("rmSync(dir, { recursive: true });"); // => [1]
 */
function recursiveRemovalLines(source: string): number[] {
  const code = blankNonCode(source);
  const lines: number[] = [];
  for (const match of code.matchAll(REMOVAL_CALL)) {
    const args = argumentsOf(code, match.index + match[0].length);
    if (/\brecursive\b/.test(args)) lines.push(code.slice(0, match.index).split('\n').length);
  }
  return lines;
}

describe('recursiveRemovalLines', () => {
  test('finds sync, async and member recursive removals', () => {
    const source = [
      'rmSync(a, { recursive: true, force: true });',
      'await rm(join(b, "x"), { force: true, recursive: true });',
      'originalFs.rmSync(c, { recursive: true });',
    ].join('\n');

    expect(recursiveRemovalLines(source)).toEqual([1, 2, 3]);
  });

  test('ignores single-file removal, strings and comments', () => {
    const source = [
      'rmSync(file, { force: true });',
      'await rm(file);',
      "const script = 'rm(dir, { recursive: true })';",
      '// rmSync(dir, { recursive: true })',
      'mkdirSync(dir, { recursive: true });',
    ].join('\n');

    expect(recursiveRemovalLines(source)).toEqual([]);
  });
});

describe('API test fixture teardown', () => {
  test('removes recursive temp directories through removeFixtureDir, not ad hoc rm', async () => {
    const files = await scanSourcePaths(TESTS_ROOT, '**/*.ts');
    const offenders = files
      .filter((file) => !(file in ALLOWED_RECURSIVE_REMOVALS))
      .flatMap((file) =>
        recursiveRemovalLines(readFileSync(join(TESTS_ROOT, file), 'utf8')).map(
          (line) => `${file}:${line}`
        )
      );

    expect(
      offenders,
      `expected no recursive rm/rmSync outside tests/support/remove-fixture-dir.ts | received: ${offenders.join(', ')}. Use removeFixtureDir (async) or removeFixtureDirSync, or add the file to ALLOWED_RECURSIVE_REMOVALS with a reason.`
    ).toEqual([]);
  });

  test('keeps every allowlisted file in the tree and still removing recursively', async () => {
    const files = new Set(await scanSourcePaths(TESTS_ROOT, '**/*.ts'));
    const stale = Object.keys(ALLOWED_RECURSIVE_REMOVALS).filter(
      (file) =>
        !files.has(file) ||
        recursiveRemovalLines(readFileSync(join(TESTS_ROOT, file), 'utf8')).length === 0
    );

    expect(
      stale,
      `expected every allowlisted file to exist and remove recursively | stale: ${stale.join(', ')}`
    ).toEqual([]);
  });
});
