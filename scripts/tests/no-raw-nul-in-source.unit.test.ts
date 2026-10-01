import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { ROOT_DIR } from '../lib/config';

/**
 * A raw 0x00 byte makes git and GitHub classify the whole file as binary:
 * diffs stop rendering, review bots cannot read the change, and `git diff`
 * needs `--text`. Source that needs a NUL (a cache-key separator, say) must
 * spell it as the escape `\u0000` instead, which yields the same string.
 */

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.md',
  '.mdx',
  '.rs',
  '.toml',
  '.yml',
  '.yaml',
  '.sh',
  '.ps1',
  '.css',
  '.html',
]);

// `.gitattributes` declares the conformance corpus `-text`: both protocol SDKs
// assert on its exact bytes, so it may carry NULs on purpose.
const EXEMPT_PREFIXES = ['spec/fixtures/'];

function trackedTextFiles(): string[] {
  const result = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: ROOT_DIR });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ls-files -z failed (exit ${result.exitCode}): ${result.stderr.toString()}`
    );
  }
  return result.stdout
    .toString()
    .split('\0')
    .filter((path) => path !== '')
    .filter((path) => TEXT_EXTENSIONS.has(extname(path)))
    .filter((path) => !EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix)));
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
