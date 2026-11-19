import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { testTempEnv } from '../lib/test-home';
import { createScratchDirs, useScratchDirs } from './support/scratch-dirs';

describe('createScratchDirs', () => {
  it('creates each directory under the given root with the prefix', () => {
    const root = mkdtempSync(join(tmpdir(), 'scratch-dirs-root-'));
    try {
      const scratch = createScratchDirs(() => root);
      const dir = scratch.make('probe-');

      expect(`${dirname(dir)} ${basename(dir).startsWith('probe-')}`).toBe(`${root} true`);
      expect(`exists: ${existsSync(dir)}`).toBe('exists: true');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes every directory it made, contents included, and leaves the root empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'scratch-dirs-root-'));
    try {
      const scratch = createScratchDirs(() => root);
      const first = scratch.make('a-');
      const second = scratch.make('b-');
      mkdirSync(join(second, 'nested'));
      writeFileSync(join(second, 'nested', 'file'), 'bytes');

      scratch.removeAll();

      expect([first, second].map((dir) => existsSync(dir))).toEqual([false, false]);
      scratch.removeAll(); // a second call has nothing to do and must not throw
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not touch a directory it did not make', () => {
    const root = mkdtempSync(join(tmpdir(), 'scratch-dirs-root-'));
    try {
      const foreign = mkdtempSync(join(root, 'foreign-'));
      const scratch = createScratchDirs(() => root);
      scratch.make('own-');

      scratch.removeAll();

      expect(`foreign exists: ${existsSync(foreign)}`).toBe('foreign exists: true');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('useScratchDirs (each)', () => {
  const makeDir = useScratchDirs();
  let created = '';

  it('creates a directory in one test', () => {
    created = makeDir('scratch-dirs-each-');
    expect(`exists: ${existsSync(created)}`).toBe('exists: true');
  });

  it('has removed it by the next test', () => {
    expect(created).not.toBe('');
    expect(`${created} exists: ${existsSync(created)}`).toBe(`${created} exists: false`);
  });
});

let madeByAllScope = '';

describe('useScratchDirs (all)', () => {
  const makeDir = useScratchDirs('all');

  it('keeps a directory across the tests of its scope', () => {
    madeByAllScope = makeDir('scratch-dirs-all-');
    expect(`exists: ${existsSync(madeByAllScope)}`).toBe('exists: true');
  });

  it('still has it in a later test of the same scope', () => {
    expect(`${madeByAllScope} exists: ${existsSync(madeByAllScope)}`).toBe(
      `${madeByAllScope} exists: true`
    );
  });
});

describe('a scope whose tests are all filtered out', () => {
  /** Runs a one-test fixture file under `--test-name-pattern`, with a private temp directory. */
  function runFiltered(fixtureBody: string): string[] {
    const root = mkdtempSync(join(tmpdir(), 'scratch-dirs-filtered-'));
    try {
      const scoped = join(root, 'tmp');
      mkdirSync(scoped);
      const fixture = join(root, 'filtered.test.ts');
      writeFileSync(
        fixture,
        `import { beforeAll, test } from 'bun:test';\n` +
          `import { useScratchDirs } from ${JSON.stringify(join(import.meta.dir, 'support', 'scratch-dirs'))};\n` +
          `const makeDir = useScratchDirs('all');\n${fixtureBody}\n` +
          `test('never selected', () => {});\n`
      );
      // Bun exits 1 when the pattern selects nothing; only what is left matters.
      Bun.spawnSync([process.execPath, 'test', '--test-name-pattern', 'matches nothing', fixture], {
        cwd: root,
        // TMPDIR alone is not enough: Windows' os.tmpdir() reads TEMP and TMP, which the
        // worker's own guarded temp directory sets, so the fixture's leak would land there.
        env: { ...process.env, ...testTempEnv(scoped) },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      return readdirSync(scoped);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  it('creates nothing when the directory is made in beforeAll', () => {
    const left = runFiltered(`beforeAll(() => { makeDir('lazy-'); });`);

    expect(left, 'expected nothing left in the temp directory').toEqual([]);
  });

  it('would leave the directory behind if it were made while the file is collected', () => {
    // The failure the beforeAll rule exists for: neither afterAll nor an exit
    // handler runs for this scope, so only creating lazily avoids the leak.
    const left = runFiltered(`makeDir('collected-');`);

    expect(left.map((name) => name.replace(/[A-Za-z0-9]{6}$/, '<random>'))).toEqual([
      'collected-<random>',
    ]);
  });
});

describe('after the (all) scope ended', () => {
  it('has removed the directory the scope made', () => {
    expect(madeByAllScope).not.toBe('');
    expect(`${madeByAllScope} exists: ${existsSync(madeByAllScope)}`).toBe(
      `${madeByAllScope} exists: false`
    );
  });
});
