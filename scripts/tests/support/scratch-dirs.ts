/**
 * Scratch directories a test creates under the OS temp directory and that are
 * removed when the test (or file) ends.
 *
 * A bare `mkdtempSync(join(tmpdir(), 'x-'))` leaves the directory behind unless
 * the test remembers to remove it, and a test that removes a *child* of it, or
 * only one of several it made, leaks the rest. One directory per run is cheap;
 * a million of them exhaust a tmpfs's inodes. Every test directory goes through
 * here so the cleanup cannot be forgotten.
 *
 * `createScratchDirs()` is the plain tracker; `useScratchDirs()` also registers
 * the removal with the surrounding `bun:test` scope.
 */

import { afterAll, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Creates directories under the temp directory and removes every one on request. */
export interface ScratchDirs {
  /**
   * Creates `<tmpdir>/<prefix><random>` and remembers it.
   *
   * @example
   * scratch.make('mango-slot-'); // => '/tmp/mango-slot-a1b2c3'
   */
  make(prefix: string): string;
  /** Removes every directory made since the last call, with its contents. Idempotent. */
  removeAll(): void;
}

/**
 * A tracker with no test-runner coupling.
 *
 * @example
 * const scratch = createScratchDirs();
 * const dir = scratch.make('mango-slot-');
 * scratch.removeAll(); // dir is gone
 */
export function createScratchDirs(tmpRoot: () => string = tmpdir): ScratchDirs {
  const made: string[] = [];
  return {
    make(prefix) {
      const dir = mkdtempSync(join(tmpRoot(), prefix));
      made.push(dir);
      return dir;
    },
    removeAll() {
      for (const dir of made.splice(0)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
  };
}

/**
 * A tracker whose directories are removed after each test (`'each'`, the
 * default) or after the last test of the enclosing `describe` or file (`'all'`).
 * Call it where the hooks should apply: inside a `describe`, or at the top of
 * the file.
 *
 * Create `'all'` directories in `beforeAll`, never while the file is collected:
 * `afterAll` does not run for a scope whose tests were all filtered out
 * (`--test-name-pattern`, which the lane's nested-runner tests use), and `bun
 * test` never fires `process.on('exit')`, so a directory made at collection
 * time and not by a hook of the same scope is left behind in that run.
 *
 * @example
 * const makeDir = useScratchDirs();
 * it('writes a file', () => { writeFileSync(join(makeDir('mango-x-'), 'a'), 'b'); });
 */
export function useScratchDirs(scope: 'each' | 'all' = 'each'): ScratchDirs['make'] {
  const scratch = createScratchDirs();
  (scope === 'each' ? afterEach : afterAll)(() => scratch.removeAll());
  return (prefix) => scratch.make(prefix);
}
