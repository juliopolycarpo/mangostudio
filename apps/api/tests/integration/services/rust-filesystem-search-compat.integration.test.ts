/**
 * Filesystem search through the real Hub codec and compiled Rust host, held to
 * the answers the retired TypeScript runtime gave for the same calls
 * (`../../support/fixtures/rust-filesystem-search-recorded.ts`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  GrepPatternError,
  PathAccessError,
  type RuntimeGlobResult,
  type RuntimeGrepResult,
} from '@mangostudio/shared/runtime-contract';
import type { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import {
  RECORDED_GLOBS,
  RECORDED_GREP_FILTERS,
  RECORDED_GREP_PATTERNS,
  type RecordedGlob,
  type RecordedGrep,
} from '../../support/fixtures/rust-filesystem-search-recorded';
import {
  cleanupMangoHome,
  resolveRustRuntimeBinary,
  scratchMangoHome,
} from '../../support/rust-runtime-binary';
import {
  type SpawnedRustRuntimeClient,
  spawnRustRuntimeClient,
} from '../../support/rust-runtime-client';

const binary = resolveRustRuntimeBinary();
const isWindows = process.platform === 'win32';
/** Only created on POSIX: `*` is not a legal Windows file-name character. */
const STAR_FILE = 'a*b.txt';

describe.skipIf(!binary.available)('Rust filesystem search matches the TypeScript runtime', () => {
  let directory: string;
  let home: string;
  let previousHome: string | undefined;
  let runtime: SpawnedRustRuntimeClient | undefined;
  let rust: RuntimeClient;

  /** A path in the runtime's answer, in the recording's placeholder form. */
  function placeholderPath(path: string): string {
    const slashed = (value: string) => value.replaceAll('\\', '/');
    return slashed(path)
      .replaceAll(slashed(directory), '<ROOT>')
      .replaceAll(slashed(dirname(directory)), '<HOME>');
  }

  /** The recording as this platform's fixture tree would have answered it. */
  function forPlatform(matches: readonly string[]): string[] {
    return isWindows ? matches.filter((match) => !match.endsWith(STAR_FILE)) : [...matches];
  }

  /** Grep matches in placeholder form, grouped by file with each file's line order kept. */
  function normalizedGrep(result: RuntimeGrepResult) {
    const matches = result.matches
      .map((match) => ({ ...match, file: placeholderPath(match.file) }))
      .sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
    return { ...result, matches };
  }

  function expectedGrep(recorded: RecordedGrep): RuntimeGrepResult {
    const result = recorded.result;
    if (!isWindows) return result;
    return {
      ...result,
      matches: result.matches.filter((match) => match.file !== STAR_FILE),
      filesScanned: result.filesScanned - (recorded.scansStarFile ? 1 : 0),
    };
  }

  beforeAll(async () => {
    previousHome = process.env.MANGO_HOME;
    home = await scratchMangoHome('search-compat');
    process.env.MANGO_HOME = home;
    directory = join(await realpath(home), 'fixtures');
    await mkdir(join(directory, 'nested'), { recursive: true });
    await mkdir(join(directory, '.hidden'));
    await mkdir(join(directory, '..', 'outside'));
    await writeFile(join(directory, 'a.txt'), 'foofoo\r\nFOO\n😀\n');
    await writeFile(join(directory, 'b.ts'), 'é １２ _ 1\nfoo\n');
    await writeFile(join(directory, 'nested', 'c.txt'), '﻿foo\nhit\nhit\n');
    await writeFile(join(directory, '.hidden', 'secret.txt'), 'foo\n');
    await writeFile(join(directory, '.hidden', '.secret.txt'), 'foo\n');
    await writeFile(join(directory, '.dot.txt'), 'foo\n');
    await writeFile(join(directory, 'binary.txt'), Buffer.from('foo\0'));
    await writeFile(join(directory, '..', 'outside', 'parent.txt'), 'foo\n');
    if (!isWindows) await writeFile(join(directory, STAR_FILE), 'foo\n');
    runtime = await spawnRustRuntimeClient(binary.path, 'search-compat');
    rust = runtime.client;
  }, 30_000);

  afterAll(async () => {
    await runtime?.close();
    if (previousHome === undefined) delete process.env.MANGO_HOME;
    else process.env.MANGO_HOME = previousHome;
    if (home) await cleanupMangoHome(home);
  });

  it('agrees on glob braces, recursive paths, explicit dots, and result caps', async () => {
    // 19 patterns x 6 option sets, as recorded; the escaped-star pattern is POSIX-only.
    expect(RECORDED_GLOBS).toHaveLength(114);
    const uncapped = new Map<string, readonly string[]>();
    const keyOf = (recorded: RecordedGlob) =>
      JSON.stringify([recorded.pattern, recorded.includeDotfiles, recorded.absolute]);
    const mismatches = [];
    for (const recorded of RECORDED_GLOBS) {
      if (isWindows && recorded.pattern === 'a\\*b.txt') continue;
      const { matches, truncated, ...options } = recorded;
      const pattern = options.pattern.startsWith('<ROOT>/')
        ? join(directory, options.pattern.slice('<ROOT>/'.length))
        : options.pattern;
      const params = { ...options, pattern, cwd: directory };
      const actual: RuntimeGlobResult = await rust.fs.glob(params);
      const actualMatches = actual.matches.map(placeholderPath);
      const expected = forPlatform(matches);
      if (!recorded.truncated) {
        uncapped.set(keyOf(recorded), expected);
        if (
          JSON.stringify([...actualMatches].sort()) !== JSON.stringify([...expected].sort()) ||
          actual.truncated !== truncated
        )
          mismatches.push({ params, actual: actualMatches, expected, truncated });
        continue;
      }
      // Which entries a cap keeps follows enumeration order, so a capped answer
      // must be `maxResults` distinct members of the recorded uncapped answer.
      const full = uncapped.get(keyOf(recorded)) ?? [];
      if (
        actual.truncated !== true ||
        actualMatches.length !== recorded.maxResults ||
        new Set(actualMatches).size !== actualMatches.length ||
        !actualMatches.every((match) => full.includes(match))
      )
        mismatches.push({ params, actual: actualMatches, expectedMembersOf: full, truncated });
    }
    expect(mismatches).toEqual([]);
  });

  it('agrees on per-component dot rules and parent or escaped grep filters', async () => {
    for (const recorded of RECORDED_GREP_FILTERS) {
      if (isWindows && recorded.glob === 'a\\*b.txt') continue;
      const params = {
        pattern: 'foo',
        inputPath: '.',
        resolvedPath: directory,
        glob: recorded.glob,
        caseInsensitive: false,
        maxResults: 100,
        maxMatchesPerFile: 10,
        maxFileSizeBytes: 1024,
        includeDotfiles: false,
      };
      expect(normalizedGrep(await rust.fs.grep(params))).toEqual(
        normalizedGrep(expectedGrep(recorded))
      );
    }
  });

  it('agrees on ECMAScript UTF-16, captures, lookbehind, boundaries, and file caps', async () => {
    expect(RECORDED_GREP_PATTERNS).toHaveLength(18);
    for (const recorded of RECORDED_GREP_PATTERNS) {
      const params = {
        pattern: recorded.pattern,
        inputPath: '.',
        resolvedPath: directory,
        caseInsensitive: true,
        maxResults: 100,
        maxMatchesPerFile: recorded.maxMatchesPerFile,
        maxFileSizeBytes: 1024,
        includeDotfiles: false,
      };
      expect(normalizedGrep(await rust.fs.grep(params))).toEqual(
        normalizedGrep(expectedGrep(recorded))
      );
    }
  });

  it('preserves typed pattern and inaccessible-root errors at the Hub boundary', async () => {
    for (const pattern of ['(', 'a'.repeat(1001)]) {
      await expect(
        rust.fs.grep({
          pattern,
          inputPath: '.',
          resolvedPath: directory,
          caseInsensitive: false,
          maxResults: 10,
          maxMatchesPerFile: 10,
          maxFileSizeBytes: 1024,
          includeDotfiles: false,
        })
      ).rejects.toBeInstanceOf(GrepPatternError);
    }
    await expect(
      rust.fs.glob({
        pattern: '*',
        cwd: join(directory, 'missing'),
        maxResults: 10,
        includeDotfiles: false,
        absolute: false,
      })
    ).rejects.toBeInstanceOf(PathAccessError);
  });
});
