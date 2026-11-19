import { describe, expect, it } from 'bun:test';

import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-contract';

import type { RuntimeClient } from '../../../../src/services/runtime-client/runtime-client';
import { createTargetPaths } from '../../../../src/services/runtime-client/target-paths';
import {
  type BaselineFile,
  foldPathKey,
  isHiddenBeforeCommand,
  parseWorkspaceListing,
  planWorkspaceChanges,
  runWithWorkspaceCheckpoint,
  selectAddedPaths,
  SHELL_WORKSPACE_LIMITS,
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

describe('foldPathKey', () => {
  it('folds case and Unicode normalization form', () => {
    expect(foldPathKey('Café/README.md')).toBe(foldPathKey('café/readme.MD'));
  });
});

/** Records every runtime call a degrading checkpoint should or should not make. */
class FakeWorkspaceRuntime {
  readonly manifest = { platform: 'linux' };
  readonly gitCalls: string[][] = [];
  readonly captureCalls: string[] = [];
  readonly hashCalls: string[] = [];

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
    exec: (params: { args: readonly string[] }) => {
      this.gitCalls.push([...params.args]);
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
    hash: (params: { path: string }) => {
      this.hashCalls.push(params.path);
      if (this.refuseSnapshots) return Promise.reject(new Error('checkpoints consent denied'));
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
  overrides: { cwd?: string; workdir?: string } = {}
): Promise<{ ran: number; result: string }> {
  let ran = 0;
  const result = await runWithWorkspaceCheckpoint({
    context: { ...context, workdir: overrides.workdir ?? context.workdir },
    runtime: runtime as unknown as RuntimeClient,
    paths,
    cwd: overrides.cwd ?? '/w',
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
