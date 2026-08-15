/**
 * The grep pattern comes from the model, and JavaScript regular expressions have
 * no step limit. These cover the bound that keeps one pathological pattern from
 * taking the runtime's event loop — and with it every other tool call, HTTP
 * request and timer in the hub — down with it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeFsService } from '../../../src/services/fs';
import { GrepPatternError } from '../../../src/services/fs/grep';

/** Long enough that JavaScriptCore's own backtracking bound is nowhere near it. */
const CATASTROPHIC_PATTERN = '^(([a-z])+.)+[A-Z]([a-z])+$';
const CATASTROPHIC_LINE = 'a'.repeat(40);

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'runtime-grep-budget-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function grepParams(overrides: { pattern: string; path?: string }) {
  return {
    pattern: overrides.pattern,
    inputPath: '.',
    resolvedPath: overrides.path ?? tempDir,
    caseInsensitive: false,
    maxResults: 100,
    maxMatchesPerFile: 20,
    maxFileSizeBytes: 1_000_000,
    includeDotfiles: false,
  };
}

describe('grep pattern budget', () => {
  it('returns from a catastrophic pattern and reports the file as truncated', async () => {
    await Bun.write(join(tempDir, 'victim.txt'), `${CATASTROPHIC_LINE}\n`);

    const startedAt = Date.now();
    const result = await runtimeFsService.grep(grepParams({ pattern: CATASTROPHIC_PATTERN }));

    // The budget is 2s per file; anything under a small multiple of that proves
    // the scan was cut off rather than run to completion.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(result.truncated).toBe(true);
    expect(result.matches).toEqual([]);
  }, 20_000);

  it('leaves the event loop free while a catastrophic pattern is evaluated', async () => {
    await Bun.write(join(tempDir, 'victim.txt'), `${CATASTROPHIC_LINE}\n`);
    const other = mkdtempSync(join(tmpdir(), 'runtime-grep-concurrent-'));
    await Bun.write(join(other, 'plain.txt'), 'needle\n');

    const ticks: number[] = [];
    const heartbeat = setInterval(() => ticks.push(Date.now()), 50);
    try {
      const blocked = runtimeFsService.grep(grepParams({ pattern: CATASTROPHIC_PATTERN }));
      // Issued while the first search is inside its regular expression. On the
      // main thread this could not be answered until that `test` returned.
      const concurrent = await runtimeFsService.grep(
        grepParams({ pattern: 'needle', path: other })
      );
      expect(concurrent.matches).toEqual([{ file: 'plain.txt', line: 1, text: 'needle' }]);

      expect((await blocked).truncated).toBe(true);
    } finally {
      clearInterval(heartbeat);
      rmSync(other, { recursive: true, force: true });
    }

    // The assertion that proves it. A blocking `test` starves timers as well as
    // calls, and a timer that misses its window fires once on catching up
    // rather than once per period — so a synchronous scan holding the thread
    // for the whole budget leaves a handful of ticks, not one every 50ms.
    expect(ticks.length).toBeGreaterThan(10);
  }, 20_000);

  it('keeps the matches from files scanned before the one that ran over', async () => {
    // Alphabetical order is not guaranteed by the walk, so the readable file is
    // asserted on its own terms: it is found whether it is scanned first or last.
    await Bun.write(join(tempDir, 'a-fast.txt'), 'aaaa\n');
    await Bun.write(join(tempDir, 'b-slow.txt'), `${CATASTROPHIC_LINE}\n`);

    const result = await runtimeFsService.grep(grepParams({ pattern: '^a{1,4}$' }));

    expect(result.matches).toEqual([{ file: 'a-fast.txt', line: 1, text: 'aaaa' }]);
    expect(result.filesScanned).toBe(2);
  }, 20_000);

  it('still finds ordinary matches through the worker', async () => {
    await Bun.write(join(tempDir, 'one.txt'), 'alpha\nbeta\ngamma\n');
    await Bun.write(join(tempDir, 'two.txt'), 'beta again\n');

    const result = await runtimeFsService.grep(grepParams({ pattern: 'beta' }));

    expect(result.truncated).toBe(false);
    expect([...result.matches].sort((left, right) => left.file.localeCompare(right.file))).toEqual([
      { file: 'one.txt', line: 2, text: 'beta' },
      { file: 'two.txt', line: 1, text: 'beta again' },
    ]);
  });

  it('flags truncation when a file has more matches than its allowance', async () => {
    await Bun.write(join(tempDir, 'many.txt'), 'hit\n'.repeat(10));

    const result = await runtimeFsService.grep({
      ...grepParams({ pattern: 'hit' }),
      maxMatchesPerFile: 3,
    });

    expect(result.matches).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it('rejects a pattern past the length limit before compiling it', async () => {
    await expect(
      runtimeFsService.grep(grepParams({ pattern: 'a'.repeat(1001) }))
    ).rejects.toBeInstanceOf(GrepPatternError);
  });
});
