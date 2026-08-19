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
import { GrepPatternError, setGrepFileBudgetForTest } from '../../../src/services/fs/grep';

const CATASTROPHIC_PATTERN = '^(([a-z])+.)+[A-Z]([a-z])+$';
const CATASTROPHIC_LINE = 'a'.repeat(40);

/**
 * Budget the overrun tests run under, in place of the production two seconds.
 *
 * Exhausting a real 2s budget means sizing the fixture against JavaScriptCore's
 * own backtracking bound, which is undocumented, enforced per `test()` call and
 * different between Bun builds — so a fixture calibrated on it goes red when an
 * upstream commit moves it, saying nothing about the budget under test. Setting
 * the budget instead inverts that dependency.
 *
 * Not smaller, because worker startup happens inside the budget: this has to
 * clear a cold thread booting under CI load, and everything past that is margin.
 */
const TEST_FILE_BUDGET_MS = 750;

/**
 * Lines in the pathological fixture — far more work than the budget can pay for,
 * rather than a measured minimum.
 *
 * The budget terminates the scan, so lines past the cut-off cost no wall-clock
 * time and buy margin against an engine quicker than the one this was written
 * on. At ~700ms per line on Bun 1.4.0-canary.1 this file is minutes of work
 * against a 750ms budget; the fixture would only stop overrunning on an engine
 * some two hundred times faster.
 */
const CATASTROPHIC_LINES = 256;

async function writeCatastrophicFile(path: string): Promise<void> {
  await Bun.write(path, `${CATASTROPHIC_LINE}\n`.repeat(CATASTROPHIC_LINES));
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'runtime-grep-budget-'));
});

afterEach(() => {
  setGrepFileBudgetForTest(null);
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
    setGrepFileBudgetForTest(TEST_FILE_BUDGET_MS);
    await writeCatastrophicFile(join(tempDir, 'victim.txt'));

    const startedAt = Date.now();
    const result = await runtimeFsService.grep(grepParams({ pattern: CATASTROPHIC_PATTERN }));

    // Returning at all is the claim: the file holds minutes of backtracking, so
    // a scan that was not cut off does not finish inside this test's timeout.
    // The bound is loose on purpose — it separates "cut off" from "ran to
    // completion", and is not a performance assertion on the budget itself.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(result.truncated).toBe(true);
    expect(result.matches).toEqual([]);
  }, 20_000);

  it('leaves the event loop free while a catastrophic pattern is evaluated', async () => {
    setGrepFileBudgetForTest(TEST_FILE_BUDGET_MS);
    await writeCatastrophicFile(join(tempDir, 'victim.txt'));
    const other = mkdtempSync(join(tmpdir(), 'runtime-grep-concurrent-'));
    await Bun.write(join(other, 'plain.txt'), 'needle\n');

    // 25ms against a 750ms budget: ~30 ticks while the thread is free, against
    // the single catch-up tick a blocking scan would leave.
    const ticks: number[] = [];
    const heartbeat = setInterval(() => ticks.push(Date.now()), 25);
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
    // for the whole budget leaves a handful of ticks, not one every 25ms.
    expect(ticks.length).toBeGreaterThan(10);
  }, 20_000);

  it('keeps the matches from files scanned before the one that ran over', async () => {
    // One pattern across both files, so the file that overruns and the file that
    // matches are the same search. `aaaAaa` satisfies the pattern immediately —
    // the uppercase letter gives it somewhere to stop — while the all-lowercase
    // lines have nothing to match and backtrack until the budget cuts them off.
    // Alphabetical order is not guaranteed by the walk, so the readable file is
    // asserted on its own terms: it is found whether it is scanned first or last.
    setGrepFileBudgetForTest(TEST_FILE_BUDGET_MS);
    await Bun.write(join(tempDir, 'a-fast.txt'), 'aaaAaa\n');
    await writeCatastrophicFile(join(tempDir, 'b-slow.txt'));

    const result = await runtimeFsService.grep(grepParams({ pattern: CATASTROPHIC_PATTERN }));

    expect(result.matches).toEqual([{ file: 'a-fast.txt', line: 1, text: 'aaaAaa' }]);
    expect(result.filesScanned).toBe(2);
    expect(result.truncated).toBe(true);
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
