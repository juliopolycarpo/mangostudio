/**
 * The scanner pool is shared across every `fs.grep` call in the process, so
 * these cover the properties that sharing has to preserve: concurrent scans on
 * different patterns must not cross-talk, and a scanner closed mid-flight must
 * not touch the pool other scans still depend on. A budget expiry not taking a
 * concurrent scan down with it is covered separately in grep-budget.test.ts,
 * through the higher-level `runtimeFsService.grep` entrypoint — that test
 * needs a genuinely catastrophic pattern to force the expiry, which reads as a
 * real ReDoS finding to static analysis when constructed directly here.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeGrepPool, createGrepScanner } from '../../../src/services/fs/grep-scanner';

function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-grep-scanner-pool-'));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('grep scanner pool', () => {
  afterEach(async () => {
    await closeGrepPool();
  });

  it('does not cross-talk between concurrent scans on different patterns', async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, 'alpha.txt'), 'alpha\n');
      await Bun.write(join(dir, 'beta.txt'), 'beta\n');

      // More scanners than the pool has workers for, so some requests must
      // queue behind others rather than each getting its own worker.
      const runs = Array.from({ length: 8 }, (_, index) => {
        const wantsAlpha = index % 2 === 0;
        const scanner = createGrepScanner(new RegExp(wantsAlpha ? 'alpha' : 'beta'));
        const file = wantsAlpha ? 'alpha.txt' : 'beta.txt';
        return scanner
          .scan(join(dir, file), 10, 2000)
          .then((outcome) => ({ wantsAlpha, outcome }))
          .finally(() => scanner.close());
      });

      const results = await Promise.all(runs);
      for (const { wantsAlpha, outcome } of results) {
        expect(outcome.incomplete).toBe(false);
        expect(outcome.matches).toEqual([{ line: 1, text: wantsAlpha ? 'alpha' : 'beta' }]);
      }
    });
  });

  it('reports a scan issued after close() as incomplete without touching the pool', async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, 'file.txt'), 'needle\n');

      const scanner = createGrepScanner(/needle/);
      await scanner.close();
      const outcome = await scanner.scan(join(dir, 'file.txt'), 10, 2000);
      expect(outcome).toEqual({ matches: [], moreMatches: false, incomplete: true });

      // The pool itself is unaffected: a fresh scanner can still scan normally.
      const other = createGrepScanner(/needle/);
      try {
        const otherOutcome = await other.scan(join(dir, 'file.txt'), 10, 2000);
        expect(otherOutcome.incomplete).toBe(false);
        expect(otherOutcome.matches).toEqual([{ line: 1, text: 'needle' }]);
      } finally {
        await other.close();
      }
    });
  });

  it('reports queued scans as incomplete when the pool is closed', async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, 'file.txt'), 'needle\n');
      const scanner = createGrepScanner(/needle/);

      try {
        // More scans than workers, issued in one turn so the extras are still
        // queued when teardown runs — the hang this covers.
        const started = Array.from({ length: 8 }, () =>
          scanner.scan(join(dir, 'file.txt'), 10, 2000)
        );
        const closedAt = Date.now();
        await closeGrepPool();
        const outcomes = await Promise.all(started);
        expect(Date.now() - closedAt).toBeLessThan(1000);

        const unfinished = outcomes.filter((outcome) => outcome.incomplete);
        expect(unfinished.length).toBeGreaterThan(0);
        for (const outcome of unfinished) {
          expect(outcome).toEqual({ matches: [], moreMatches: false, incomplete: true });
        }

        // Teardown is not terminal: a later grep grows the pool again.
        const other = createGrepScanner(/needle/);
        try {
          const otherOutcome = await other.scan(join(dir, 'file.txt'), 10, 2000);
          expect(otherOutcome.incomplete).toBe(false);
          expect(otherOutcome.matches).toEqual([{ line: 1, text: 'needle' }]);
        } finally {
          await other.close();
        }
      } finally {
        await scanner.close();
      }
    });
  });
});
