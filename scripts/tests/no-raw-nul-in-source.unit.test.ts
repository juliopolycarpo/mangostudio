import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from '../lib/config';

/**
 * A raw 0x00 byte makes git and GitHub classify the whole file as binary:
 * diffs stop rendering, review bots cannot read the change, and `git diff`
 * needs `--text`. Source that needs a NUL (a cache-key separator, say) must
 * spell it as the escape `\u0000` instead, which yields the same string.
 *
 * The candidate set comes from `.gitattributes`, not from an extension list:
 * every tracked file is scanned unless the attributes declare it `-text`
 * (`binary` assets, and the `spec/fixtures/` conformance corpus whose exact
 * bytes both protocol SDKs assert on). A new text format is covered
 * automatically.
 */

/** `git ls-files --eol -z` entry: `i/lf    w/lf    attr/text eol=lf  \tpath`. */
const EOL_ENTRY = /^i\/(\S+)\s+w\/\S+\s+attr\/(.*?)\s*\t(.+)$/s;

/**
 * Tracked files whose attributes declare them text, from `git ls-files --eol`.
 * Usage: `trackedTextFiles()` -> `['apps/api/src/index.ts', ...]`
 */
function trackedTextFiles(): string[] {
  const result = Bun.spawnSync(['git', 'ls-files', '--eol', '-z'], { cwd: ROOT_DIR });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ls-files --eol -z failed (exit ${result.exitCode}): ${result.stderr.toString()}` +
        ' | expected: a git checkout at the repository root'
    );
  }
  const paths: string[] = [];
  for (const entry of result.stdout.toString().split('\0')) {
    if (entry === '') continue;
    const match = EOL_ENTRY.exec(entry);
    if (match === null) {
      throw new Error(
        `unparseable git ls-files --eol entry: ${JSON.stringify(entry)} | expected: "i/<eol> w/<eol> attr/<attrs>\\t<path>"`
      );
    }
    const [, indexEol, attrs, path] = match;
    if (indexEol === 'none') continue; // empty file or symlink: no content to scan
    if (attrs.startsWith('-text')) continue; // declared binary / byte-exact data
    if (!existsSync(join(ROOT_DIR, path))) continue; // tracked but deleted in this worktree
    paths.push(path);
  }
  return paths;
}

/** Offset of the first 0x00 byte, or -1. // Usage: firstNulOffset(Buffer.from('a\0b')) === 1 */
function firstNulOffset(bytes: Uint8Array): number {
  return bytes.indexOf(0);
}

describe('tracked text source carries no raw NUL byte', () => {
  const files = trackedTextFiles();

  test('scans a set of files that is neither empty nor accidentally tiny', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  test('follows .gitattributes: includes every text format, skips -text data', () => {
    const included = ['Cargo.lock', 'package.json', 'apps/api/src/index.ts'];
    const excluded = ['apps/frontend/public/favicon.ico', 'bun.lock'];

    const missing = included.filter((path) => !files.includes(path));
    const leaked = [
      ...excluded.filter((path) => files.includes(path)),
      ...files.filter((path) => path.startsWith('spec/fixtures/')),
    ];

    expect({ missing, leaked }).toEqual({ missing: [], leaked: [] });
  });

  test('detects a raw NUL and accepts the escaped spelling', () => {
    expect(firstNulOffset(Buffer.from('a\u0000b'))).toBe(1);
    expect(firstNulOffset(Buffer.from('a\\u0000b'))).toBe(-1);
  });

  test('finds no tracked text file containing a raw NUL', () => {
    const offenders = files
      .filter((path) => firstNulOffset(readFileSync(join(ROOT_DIR, path))) >= 0)
      .map((path) => `${path} (write the separator as \\u0000)`);

    expect(offenders).toEqual([]);
  });
});
