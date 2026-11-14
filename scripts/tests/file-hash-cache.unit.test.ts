import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileHashCache } from '../lib/file-hash-cache';
import { hashInputContent } from '../lib/pass-stamp';
import { canonicalPath } from './support/canonical-path';

const directories: string[] = [];

function createDirectory(): string {
  const directory = canonicalPath(mkdtempSync(join(tmpdir(), 'mango-file-hash-cache-')));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** A wall clock the test sets. */
class FakeClock {
  constructor(public ms: number) {}
  now = (): number => this.ms;
}

/** The reader behind a cache miss; records each path it is asked to read. */
class CountingHasher {
  paths: string[] = [];
  hash = (path: string): string | null => {
    this.paths.push(path);
    return hashInputContent(path);
  };
}

const SETTLED_MS = () => Date.now() + 180_000;

function setup() {
  const directory = createDirectory();
  const cachePath = join(directory, 'cache', 'hashes.cache');
  const clock = new FakeClock(SETTLED_MS());
  const hasher = new CountingHasher();
  const open = () => createFileHashCache(cachePath, { now: clock.now, hashFile: hasher.hash });
  return { directory, cachePath, clock, hasher, open };
}

function persistedPaths(cachePath: string): string[] {
  const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as { files: Record<string, unknown> };
  return Object.keys(parsed.files).sort();
}

describe('createFileHashCache', () => {
  test('answers what hashInputContent answers, and persists a settled file', () => {
    const { directory, cachePath, open } = setup();
    const file = join(directory, 'a.ts');
    writeFileSync(file, 'export const a = 1;\n');
    const pass = open().startPass();
    expect(pass.hashOf(file)).toBe(hashInputContent(file));
    pass.commit();
    expect(persistedPaths(cachePath)).toEqual([file]);
  });

  test('a missing path, a directory and a path under a file carry no content', () => {
    const { directory, open } = setup();
    const file = join(directory, 'a.ts');
    writeFileSync(file, 'x');
    const pass = open().startPass();
    expect(pass.hashOf(join(directory, 'missing.ts'))).toBeNull();
    expect(pass.hashOf(directory)).toBeNull();
    expect(pass.hashOf(join(file, 'below'))).toBeNull();
  });

  // Creating a symlink needs privileges Windows CI runners do not grant.
  test.skipIf(process.platform === 'win32')(
    'a symlink is read through on every pass and never stored',
    () => {
      const { directory, cachePath, hasher, open } = setup();
      const target = join(directory, 'target.ts');
      const link = join(directory, 'link.ts');
      writeFileSync(target, 'one');
      symlinkSync(target, link);
      const cache = open();
      for (const content of ['one', 'two']) {
        writeFileSync(target, content);
        const pass = cache.startPass();
        expect(
          pass.hashOf(link),
          `(file hash cache): expected the hash of the link target "${content}"`
        ).toBe(hashInputContent(target));
        // The target is a regular file and does persist, which proves the cache wrote.
        pass.hashOf(target);
        pass.commit();
      }
      expect(hasher.paths.filter((path) => path === link)).toHaveLength(2);
      expect(persistedPaths(cachePath)).toEqual([target]);
    }
  );

  test('an entry within the racy window is not stored, and one past it is', () => {
    const { directory, cachePath, clock, open } = setup();
    const file = join(directory, 'a.ts');
    writeFileSync(file, 'x');
    // Just written: the clock is inside the window.
    clock.ms = Date.now();
    let pass = open().startPass();
    pass.hashOf(file);
    pass.commit();
    expect(
      () => readFileSync(cachePath),
      '(file hash cache): expected no cache file yet'
    ).toThrow();
    clock.ms = SETTLED_MS();
    pass = open().startPass();
    pass.hashOf(file);
    pass.commit();
    expect(persistedPaths(cachePath)).toEqual([file]);
  });

  test('a file whose mtime lies in the future is not stored', () => {
    const { directory, cachePath, clock, open } = setup();
    const file = join(directory, 'a.ts');
    writeFileSync(file, 'x');
    clock.ms = Date.now() - 3_600_000;
    const pass = open().startPass();
    pass.hashOf(file);
    pass.commit();
    expect(() => readFileSync(cachePath)).toThrow();
  });

  test('a commit drops entries the pass did not use and leaves an unchanged cache alone', () => {
    const { directory, cachePath, open } = setup();
    const kept = join(directory, 'kept.ts');
    const gone = join(directory, 'gone.ts');
    writeFileSync(kept, 'k');
    writeFileSync(gone, 'g');
    const cache = open();
    let pass = cache.startPass();
    pass.hashOf(kept);
    pass.hashOf(gone);
    pass.commit();
    expect(persistedPaths(cachePath)).toEqual([gone, kept].sort());
    rmSync(cachePath);
    // Nothing changed since the load: a second commit must not recreate the file.
    pass = cache.startPass();
    pass.hashOf(kept);
    pass.hashOf(gone);
    pass.commit();
    expect(() => readFileSync(cachePath), '(file hash cache): expected no rewrite').toThrow();
    pass = cache.startPass();
    pass.hashOf(kept);
    pass.commit();
    expect(persistedPaths(cachePath)).toEqual([kept]);
  });

  test('a write that fails is dropped and leaves no temporary file behind', () => {
    const { directory, clock } = setup();
    const file = join(directory, 'a.ts');
    writeFileSync(file, 'x');
    // The cache path is a non-empty directory: the temporary file is written
    // beside it and the rename onto it is what fails.
    const cacheDirectory = join(directory, 'stamps');
    const occupied = join(cacheDirectory, 'hashes.cache');
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, 'keep'), 'x');
    const pass = createFileHashCache(occupied, { now: clock.now }).startPass();
    expect(pass.hashOf(file)).toBe(hashInputContent(file));
    expect(() => pass.commit()).not.toThrow();
    expect(
      readdirSync(cacheDirectory),
      '(file hash cache): expected no temporary file left beside the cache'
    ).toEqual(['hashes.cache']);
  });

  test('a cache file in a directory that does not exist yet is created', () => {
    const { directory, cachePath, open } = setup();
    const file = join(directory, 'a.ts');
    writeFileSync(file, 'x');
    const pass = open().startPass();
    pass.hashOf(file);
    pass.commit();
    expect(persistedPaths(cachePath)).toEqual([file]);
  });
});
