import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findGitRoot,
  formatStartTiming,
  formatTreeRead,
  readTree,
  type RunCommand,
  timeStarts,
} from '../lib/windows-cold-start';
import { readText } from './support/read-text';

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A clock that advances by the queued amounts, one per reading. */
function fakeClock(steps: readonly number[]): () => number {
  let time = 0;
  let index = 0;
  return () => {
    const value = time;
    time += steps[index] ?? 0;
    index += 1;
    return value;
  };
}

describe('timeStarts', () => {
  test('times the first and the second run of one command separately', () => {
    // Readings 0, 9000, 9000, 9300: the first run took 9 s and the second 0.3 s.
    const clock = fakeClock([9_000, 0, 300]);
    const seen: string[][] = [];
    const run: RunCommand = (command) => {
      seen.push([...command]);
      return 0;
    };
    expect(timeStarts({ label: 'bash', command: ['bash', '-c', 'true'] }, run, clock)).toEqual({
      label: 'bash',
      firstMs: 9_000,
      secondMs: 300,
      exitCode: 0,
    });
    expect(seen).toEqual([
      ['bash', '-c', 'true'],
      ['bash', '-c', 'true'],
    ]);
  });

  test('passes the target environment to both runs and keeps a missing tool as exit null', () => {
    const envs: unknown[] = [];
    const run: RunCommand = (_command, env) => {
      envs.push(env);
      return null;
    };
    const timing = timeStarts(
      { label: 'ln', command: ['ln'], env: { MSYS: 'winsymlinks:nativestrict' } },
      run,
      fakeClock([])
    );
    expect(timing.exitCode).toBeNull();
    expect(envs).toEqual([
      { MSYS: 'winsymlinks:nativestrict' },
      { MSYS: 'winsymlinks:nativestrict' },
    ]);
  });
});

describe('formatStartTiming', () => {
  test('flags a first start far above its second as COLD', () => {
    expect(formatStartTiming({ label: 'bash', firstMs: 9_000, secondMs: 300, exitCode: 0 })).toBe(
      '[windows-cold-start] start bash: first 9000 ms, second 300 ms, exit 0 COLD'
    );
  });

  test.each([
    ['a slow pair', 9_000, 8_000],
    ['a quick first start', 900, 100],
  ])('does not flag %s', (_label, firstMs, secondMs) => {
    expect(formatStartTiming({ label: 'x', firstMs, secondMs, exitCode: 0 })).not.toContain('COLD');
  });
});

describe('readTree', () => {
  function stageTree(): string {
    const root = mkdtempSync(join(tmpdir(), 'mango-cold-start-tree-'));
    scratchRoots.push(root);
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'a.bin'), Buffer.alloc(10));
    writeFileSync(join(root, 'nested', 'b.bin'), Buffer.alloc(20));
    writeFileSync(join(root, 'huge.bin'), Buffer.alloc(500));
    return root;
  }

  test('reads every file under the root and skips one over the size cap', () => {
    const root = stageTree();
    const timing = readTree('fixture', root, { maxFileBytes: 100, budgetMs: 1_000 }, fakeClock([]));
    expect(timing).toMatchObject({
      label: 'fixture',
      root,
      files: 2,
      bytes: 30,
      skipped: 1,
      truncated: false,
    });
  });

  test('stops at the time budget and says so', () => {
    const root = stageTree();
    // The start reading is 0; every later reading is 10 s further on.
    const clock = fakeClock([10_000, 10_000, 10_000, 10_000, 10_000, 10_000]);
    const timing = readTree('fixture', root, { maxFileBytes: 100, budgetMs: 5_000 }, clock);
    expect(timing.truncated).toBe(true);
    expect(timing.files).toBe(0);
  });

  test('a root that does not exist reads as an empty tree', () => {
    const timing = readTree(
      'absent',
      join(tmpdir(), 'mango-cold-start-absent'),
      { maxFileBytes: 100, budgetMs: 1_000 },
      fakeClock([])
    );
    expect(timing).toMatchObject({ files: 0, bytes: 0, truncated: false });
  });
});

/** A Git for Windows install that has only `<root>\bin\bash.exe`. */
function fakeGitInstall(root: string): (path: string) => boolean {
  return (path) => path === `${root}\\bin\\bash.exe`;
}

describe('findGitRoot', () => {
  const root = 'C:\\Program Files\\Git';

  test.each([
    ['the cmd shim PowerShell finds', `${root}\\cmd\\git.exe`],
    ['the ucrt64 binary a Git Bash step finds', `${root}\\ucrt64\\bin\\git.exe`],
    ['the mingw64 binary of older installs', `${root}\\mingw64\\bin\\git.exe`],
    ['the libexec binary', `${root}\\mingw64\\libexec\\git-core\\git.exe`],
  ])('walks up from %s to the directory holding bin\\bash.exe', (_name, gitExecutable) => {
    expect(findGitRoot(gitExecutable, fakeGitInstall(root))).toBe(root);
  });

  test('a git.exe with no bash above it has no root', () => {
    expect(findGitRoot('C:\\tools\\git\\git.exe', fakeGitInstall(root))).toBeUndefined();
  });
});

describe('formatTreeRead', () => {
  test('prints the size, the time and any truncation', () => {
    expect(
      formatTreeRead({
        label: 'git-usr-bin',
        root: 'C:\\Git\\usr\\bin',
        files: 3,
        bytes: 3_500_000,
        ms: 1_200,
        skipped: 1,
        truncated: true,
      })
    ).toBe(
      '[windows-cold-start] read git-usr-bin: 3 files, 3.5 MB in 1200 ms, 1 skipped, TRUNCATED at the budget (C:\\Git\\usr\\bin)'
    );
  });
});

describe('the Windows pull-request workflow runs the cold-start probe', () => {
  const workflow = readText('.github/workflows/windows-pr-tests.yml');

  test('before the API lane, and never as a verdict', () => {
    const probe = workflow.indexOf('bun scripts/ci/windows-cold-start.ts');
    const apiLane = workflow.indexOf('bun run --filter @mangostudio/api test:unit');
    expect(probe, 'expected the workflow to run scripts/ci/windows-cold-start.ts').toBeGreaterThan(
      -1
    );
    expect(probe, 'expected the probe before the API unit lane').toBeLessThan(apiLane);
    const step = workflow.slice(workflow.lastIndexOf('- name:', probe), probe);
    expect(step, 'expected the probe step to be advisory (continue-on-error: true)').toContain(
      'continue-on-error: true'
    );
    expect(step, 'expected a bounded probe step (timeout-minutes)').toMatch(/timeout-minutes: \d+/);
  });
});
