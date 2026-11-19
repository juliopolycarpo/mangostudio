import { describe, expect, it } from 'bun:test';

import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-contract';

import type { RuntimeClient } from '../../../../src/services/runtime-client/runtime-client';
import { createTargetPaths } from '../../../../src/services/runtime-client/target-paths';
import {
  type BaselineFile,
  COMMAND_WINDOW_SLACK_MS,
  foldPathKey,
  isHiddenBeforeCommand,
  parseWorkspaceListing,
  planWorkspaceChanges,
  runWithWorkspaceCheckpoint,
  selectAddedPaths,
  SHELL_WORKSPACE_LIMITS,
  type ShellWorkspaceLimits,
  wasWrittenDuringCommand,
} from '../../../../src/services/tools/shell-workspace-checkpoint';
import type { ToolContext } from '../../../../src/services/tools/types';

const NUL = '\0';

function trackedRecord(mode: string, path: string, stage = 0): string {
  return `${mode} ${'a'.repeat(40)} ${stage}\t${path}`;
}

describe('parseWorkspaceListing', () => {
  it('keeps regular tracked files and bare untracked paths', () => {
    const stdout = [
      trackedRecord('100644', 'src/a.ts'),
      trackedRecord('100755', 'bin/run'),
      'notes/new.md',
    ].join(NUL);

    expect(parseWorkspaceListing(stdout)).toEqual(['src/a.ts', 'bin/run', 'notes/new.md']);
  });

  it('skips symlinks and gitlinks, which capture would follow', () => {
    const stdout = [
      trackedRecord('120000', 'link'),
      trackedRecord('160000', 'vendor/submodule'),
      trackedRecord('100644', 'plain.txt'),
    ].join(NUL);

    expect(parseWorkspaceListing(stdout)).toEqual(['plain.txt']);
  });

  it('lists a conflicted path once and skips a nested repository directory', () => {
    const stdout = [
      trackedRecord('100644', 'conflict.txt', 1),
      trackedRecord('100644', 'conflict.txt', 2),
      trackedRecord('100644', 'conflict.txt', 3),
      'nested-repo/',
      '',
    ].join(NUL);

    expect(parseWorkspaceListing(stdout)).toEqual(['conflict.txt']);
  });

  it('keeps a path containing a tab and drops one git could not decode', () => {
    const stdout = [trackedRecord('100644', 'odd\tname.txt'), 'bad�name.txt'].join(NUL);

    expect(parseWorkspaceListing(stdout)).toEqual(['odd\tname.txt']);
  });
});

describe('isHiddenBeforeCommand', () => {
  const ignored = new Set(['node_modules/', 'dist/cache/', 'debug.log']);

  it('matches an ignored file and anything under an ignored directory', () => {
    expect(isHiddenBeforeCommand('debug.log', ignored)).toBe(true);
    expect(isHiddenBeforeCommand('node_modules/pkg/index.js', ignored)).toBe(true);
    expect(isHiddenBeforeCommand('dist/cache/a/b.bin', ignored)).toBe(true);
  });

  it('does not match siblings that merely share a prefix', () => {
    expect(isHiddenBeforeCommand('node_modules_extra/a.js', ignored)).toBe(false);
    expect(isHiddenBeforeCommand('dist/other.js', ignored)).toBe(false);
    expect(isHiddenBeforeCommand('debug.log.txt', ignored)).toBe(false);
  });
});

describe('planWorkspaceChanges', () => {
  const baseline = new Map<string, BaselineFile>([
    ['/w/same.txt', { hash: 'h-same', contentBase64: 'AA==' }],
    ['/w/edited.txt', { hash: 'h-old', contentBase64: 'AA==' }],
    ['/w/deleted.txt', { hash: 'h-del', contentBase64: 'AA==' }],
    ['/w/absent.txt', { hash: null }],
  ]);

  it('classifies edits, deletes and creates and ignores unchanged paths', () => {
    const current = new Map<string, string | null>([
      ['/w/same.txt', 'h-same'],
      ['/w/edited.txt', 'h-new'],
      ['/w/deleted.txt', null],
      ['/w/absent.txt', null],
      ['/w/created.txt', 'h-created'],
    ]);

    expect(planWorkspaceChanges(baseline, current).map(({ path, op }) => [path, op])).toEqual([
      ['/w/edited.txt', 'edit'],
      ['/w/deleted.txt', 'delete'],
      ['/w/created.txt', 'create'],
    ]);
  });

  it('treats a baseline-absent file that now exists as a create', () => {
    const [change] = planWorkspaceChanges(baseline, new Map([['/w/absent.txt', 'h-now']]));

    expect(change).toMatchObject({ op: 'create', before: { hash: null }, afterHash: 'h-now' });
  });

  it('leaves out a path whose current hash could not be read', () => {
    expect(planWorkspaceChanges(baseline, new Map())).toEqual([]);
  });
});

describe('selectAddedPaths', () => {
  const before = new Set(['a.txt', 'unreadable.txt', 'Foo.ts']);

  it('never calls a path the pre-command listing named new, readable or not', () => {
    const result = selectAddedPaths(['a.txt', 'unreadable.txt', 'fresh.txt'], before, null);

    expect(result).toEqual({ added: ['fresh.txt'], renamedByCase: [] });
  });

  it('treats a path differing only in case as new on a case-sensitive filesystem', () => {
    expect(selectAddedPaths(['foo.ts'], before, null)).toEqual({
      added: ['foo.ts'],
      renamedByCase: [],
    });
  });

  it('reports a case-only rename instead of a create on a case-folding filesystem', () => {
    const folded = new Set([...before].map(foldPathKey));

    expect(selectAddedPaths(['foo.ts', 'fresh.txt', 'Foo.ts'], before, folded)).toEqual({
      added: ['fresh.txt'],
      renamedByCase: ['foo.ts'],
    });
  });
});

describe('wasWrittenDuringCommand', () => {
  const window = { startedAt: 100_000, endedAt: 105_000 };

  it('accepts a time inside the window and within the clock slack of either edge', () => {
    expect(wasWrittenDuringCommand(102_000, window)).toBe(true);
    expect(wasWrittenDuringCommand(100_000 - COMMAND_WINDOW_SLACK_MS, window)).toBe(true);
    expect(wasWrittenDuringCommand(105_000 + COMMAND_WINDOW_SLACK_MS, window)).toBe(true);
  });

  it('rejects a file written before the snapshot finished or after the diff began', () => {
    expect(wasWrittenDuringCommand(100_000 - COMMAND_WINDOW_SLACK_MS - 1, window)).toBe(false);
    expect(wasWrittenDuringCommand(105_000 + COMMAND_WINDOW_SLACK_MS + 1, window)).toBe(false);
  });

  it('treats an unknown or non-finite time as no evidence', () => {
    expect(wasWrittenDuringCommand(undefined, window)).toBe(false);
    expect(wasWrittenDuringCommand(Number.NaN, window)).toBe(false);
  });
});

describe('foldPathKey', () => {
  it('folds case and Unicode normalization form', () => {
    expect(foldPathKey('Café/README.md')).toBe(foldPathKey('café/readme.MD'));
  });
});

/** Records every runtime call a degrading checkpoint should or should not make. */
class FakeWorkspaceRuntime {
  readonly manifest = { platform: 'linux' };
  readonly gitCalls: string[][] = [];
  readonly gitTimeoutsMs: Array<number | undefined> = [];
  readonly captureCalls: string[] = [];
  readonly hashCalls: string[] = [];
  /**
   * Hashes after this many calls never answer on their own and reject only when
   * their request is aborted, like a runtime that stopped responding mid-run.
   */
  stallHashesAfter: number | undefined;

  constructor(
    private readonly gitOutcome: { exitCode: number; stdout: string } | 'throw',
    private readonly refuseSnapshots = false,
    /** What `snapshot.hash` answers; a runtime older than the stat fields sends only `hash`. */
    private readonly hashResult: {
      hash: string | null;
      size?: number;
      modifiedAtMs?: number;
      symlink?: boolean;
    } = { hash: null }
  ) {}

  readonly git = {
    exec: (params: { args: readonly string[]; timeoutMs?: number }) => {
      this.gitCalls.push([...params.args]);
      this.gitTimeoutsMs.push(params.timeoutMs);
      if (this.gitOutcome === 'throw') return Promise.reject(new Error('git consent denied'));
      return Promise.resolve({ stderr: '', ...this.gitOutcome });
    },
  };

  readonly snapshot = {
    capture: (params: { path: string }) => {
      this.captureCalls.push(params.path);
      if (this.refuseSnapshots) return Promise.reject(new Error('checkpoints consent denied'));
      return Promise.resolve({ exists: false });
    },
    hash: (params: { path: string }, options?: { signal?: AbortSignal }) => {
      this.hashCalls.push(params.path);
      if (this.refuseSnapshots) return Promise.reject(new Error('checkpoints consent denied'));
      if (this.stallHashesAfter !== undefined && this.hashCalls.length > this.stallHashesAfter) {
        return new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('request aborted')));
        });
      }
      return Promise.resolve(this.hashResult);
    },
  };
}

const paths = createTargetPaths({
  pathStyle: 'posix',
  homeDir: '/home/fixture',
} as RuntimeCapabilityManifest);

// No `assistantMessageId`: the source note is then a no-op, so these assert the
// runtime traffic and the command's own result without a database.
const context: ToolContext = {
  userId: 'u1',
  chatId: 'c1',
  workdir: '/w',
  parameters: {},
};

async function runDegraded(
  runtime: FakeWorkspaceRuntime,
  overrides: { cwd?: string; workdir?: string; limits?: ShellWorkspaceLimits } = {}
): Promise<{ ran: number; result: string }> {
  let ran = 0;
  const result = await runWithWorkspaceCheckpoint({
    context: { ...context, workdir: overrides.workdir ?? context.workdir },
    runtime: runtime as unknown as RuntimeClient,
    paths,
    cwd: overrides.cwd ?? '/w',
    ...(overrides.limits ? { limits: overrides.limits } : {}),
    run: () => {
      ran += 1;
      return Promise.resolve('command-result');
    },
  });
  return { ran, result };
}

describe('runWithWorkspaceCheckpoint degradation', () => {
  it('runs the command once and snapshots nothing when git cannot list the workdir', async () => {
    const runtime = new FakeWorkspaceRuntime({ exitCode: 128, stdout: '' });

    expect(await runDegraded(runtime)).toEqual({ ran: 1, result: 'command-result' });
    expect(runtime.captureCalls).toEqual([]);
  });

  it('runs the command when the git call itself is refused', async () => {
    const runtime = new FakeWorkspaceRuntime('throw');

    expect(await runDegraded(runtime)).toEqual({ ran: 1, result: 'command-result' });
    expect(runtime.captureCalls).toEqual([]);
  });

  it(`degrades above ${SHELL_WORKSPACE_LIMITS.maxFiles} files without capturing any`, async () => {
    const listing = Array.from(
      { length: SHELL_WORKSPACE_LIMITS.maxFiles + 1 },
      (_, index) => `f${index}.txt`
    ).join(NUL);
    const runtime = new FakeWorkspaceRuntime({ exitCode: 0, stdout: listing });

    expect(await runDegraded(runtime)).toEqual({ ran: 1, result: 'command-result' });
    expect(runtime.captureCalls).toEqual([]);
  });

  it('does not list or snapshot a workdir the command is not running in', async () => {
    const runtime = new FakeWorkspaceRuntime({ exitCode: 0, stdout: 'a.txt' });

    expect(await runDegraded(runtime, { cwd: '/elsewhere' })).toEqual({
      ran: 1,
      result: 'command-result',
    });
    expect(runtime.gitCalls).toEqual([]);
  });

  it('does not list or snapshot when the chat has no workdir', async () => {
    const runtime = new FakeWorkspaceRuntime({ exitCode: 0, stdout: 'a.txt' });
    let ran = 0;
    await runWithWorkspaceCheckpoint({
      context: { userId: 'u1', chatId: 'c1', parameters: {} },
      runtime: runtime as unknown as RuntimeClient,
      paths,
      cwd: undefined,
      run: () => {
        ran += 1;
        return Promise.resolve(null);
      },
    });

    expect(ran).toBe(1);
    expect(runtime.gitCalls).toEqual([]);
  });

  it('stops statting once the runtime refuses its snapshot methods', async () => {
    const listing = Array.from({ length: 40 }, (_, index) => `f${index}.txt`).join(NUL);
    const runtime = new FakeWorkspaceRuntime({ exitCode: 0, stdout: listing }, true);

    expect(await runDegraded(runtime)).toEqual({ ran: 1, result: 'command-result' });
    // A consent refusal is refused 40 times over if each file is tried; the
    // limit keeps a denied capability from costing a round trip per file.
    expect(runtime.hashCalls.length).toBeLessThan(40);
    expect(runtime.captureCalls).toEqual([]);
  });

  it('degrades without capturing when the runtime cannot say whether a path is a link', async () => {
    const runtime = new FakeWorkspaceRuntime({ exitCode: 0, stdout: 'a.txt' }, false, {
      hash: 'h-a',
    });

    expect(await runDegraded(runtime)).toEqual({ ran: 1, result: 'command-result' });
    // `hash` alone follows links, so a restore could write through one: without
    // `size`/`symlink` in the answer, nothing is captured at all.
    expect(runtime.captureCalls).toEqual([]);
  });

  it('sizes the snapshot from stat before loading any content through the pipe', async () => {
    const sixMiB = 6 * 1024 * 1024;
    const runtime = new FakeWorkspaceRuntime(
      { exitCode: 0, stdout: ['a.bin', 'b.bin', 'c.bin'].join(NUL) },
      false,
      { hash: 'h', size: sixMiB, modifiedAtMs: 1, symlink: false }
    );

    expect(await runDegraded(runtime)).toEqual({ ran: 1, result: 'command-result' });
    // 18 MiB against a 16 MiB cap is known from the sizes alone; capturing even
    // one file first spends base64 through the pipe on a snapshot that degrades.
    expect(runtime.captureCalls).toEqual([]);
  });

  it('hands each git listing only the setup budget that is left', async () => {
    const runtime = new FakeWorkspaceRuntime({ exitCode: 0, stdout: 'a.txt' });

    await runDegraded(runtime, {
      limits: { ...SHELL_WORKSPACE_LIMITS, setupBudgetMs: 800 },
    });
    expect(runtime.gitTimeoutsMs.length).toBeGreaterThan(0);
    for (const timeoutMs of runtime.gitTimeoutsMs) {
      expect(
        timeoutMs !== undefined && timeoutMs > 0 && timeoutMs <= 800,
        `expected every git timeoutMs in (0, 800] | received ${JSON.stringify(runtime.gitTimeoutsMs)}`
      ).toBe(true);
    }
  });

  it('stops waiting on a runtime that stalls after the command, within the same budget', async () => {
    const runtime = new FakeWorkspaceRuntime({ exitCode: 0, stdout: 'a.txt' }, false, {
      hash: 'h',
      size: 1,
      modifiedAtMs: 1,
      symlink: false,
    });
    // The baseline stat answers; every hash after it hangs.
    runtime.stallHashesAfter = 1;

    const outcome = await Promise.race([
      runDegraded(runtime, { limits: { ...SHELL_WORKSPACE_LIMITS, setupBudgetMs: 100 } }),
      new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), 2_000)),
    ]);
    expect(
      outcome,
      'expected the post-command pass to give up inside its 100 ms budget | received: still waiting after 2000 ms'
    ).toEqual({ ran: 1, result: 'command-result' });
  });

  it('does not capture a symlink the runtime reports', async () => {
    const runtime = new FakeWorkspaceRuntime({ exitCode: 0, stdout: 'link.txt' }, false, {
      hash: 'h-target',
      size: 4,
      symlink: true,
    });

    await runDegraded(runtime);
    expect(runtime.captureCalls).toEqual([]);
  });
});
