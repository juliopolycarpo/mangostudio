/**
 * The key every repository mutation now shares.
 *
 * The regression: ordinary git writes and `gh pr checkout` locked on the
 * caller's own root while worktree administration locked on the common
 * directory. Two chats in two worktrees of one repository therefore took
 * different locks and raced on the same refs and worktree registry — which is
 * a lock-file failure at best, and a command acting on branch state that moved
 * under it at worst.
 */

import { describe, expect, it } from 'bun:test';
import { createRepoMutationLock } from '../../../../src/modules/git/application/git-mutation-lock';
import type { runGit } from '../../../../src/modules/git/infrastructure/git-cli';
import { createTargetPaths } from '../../../../src/services/runtime-client/target-paths';

/** Git's own answer: relative from the main worktree, absolute from a linked one. */
const COMMON_DIR_BY_CWD: Readonly<Record<string, string>> = {
  '/repo': '.git\n',
  '/work/linked': '/repo/.git\n',
  'C:\\Repo': '.git\n',
  'c:\\work\\linked': 'C:\\repo\\.git\n',
};

/**
 * `git rev-parse --git-common-dir` without a subprocess. Named rather than
 * inlined so both suites below read the same table of Git answers.
 */
function fakeRunGit(): typeof runGit {
  return ((_args: readonly string[], options: { cwd: string }) =>
    Promise.resolve({
      stdout: COMMON_DIR_BY_CWD[options.cwd] ?? '.git\n',
      stderr: '',
      exitCode: 0,
    })) as unknown as typeof runGit;
}

function lockFor(pathStyle: 'posix' | 'win32') {
  const paths = createTargetPaths({
    pathStyle,
    homeDir: pathStyle === 'win32' ? 'C:\\Users\\dev' : '/home/dev',
  } as Parameters<typeof createTargetPaths>[0]);

  return createRepoMutationLock({
    runGit: fakeRunGit(),
    readTargetPaths: () => Promise.resolve(paths),
  });
}

const SELECTION = { userId: 'user-1', environmentId: 'local' };

describe('resolveRepoLockScope', () => {
  it('gives the main worktree and a linked worktree one scope', async () => {
    const { resolveRepoLockScope } = lockFor('posix');

    const main = await resolveRepoLockScope('/repo', SELECTION);
    const linked = await resolveRepoLockScope('/work/linked', SELECTION);

    expect(main).toBe('/repo/.git');
    expect(linked).toBe(main);
  });

  it('folds casing on a Windows runtime, where the queue key cannot compare', async () => {
    const { resolveRepoLockScope } = lockFor('win32');

    const main = await resolveRepoLockScope('C:\\Repo', SELECTION);
    const linked = await resolveRepoLockScope('c:\\work\\linked', SELECTION);

    expect(linked).toBe(main);
  });
});

describe('withRepoMutationLock', () => {
  it('serializes a mutation from a linked worktree behind one from the main worktree', async () => {
    const { withRepoMutationLock } = lockFor('posix');
    const log: string[] = [];
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withRepoMutationLock(SELECTION, '/repo', async () => {
      log.push('main:enter');
      await firstHeld;
      log.push('main:exit');
    });
    // Awaited before the second call so the first has actually entered: the
    // scope resolves through its own `rev-parse`, so nothing is queued until
    // that promise settles.
    await Promise.resolve();
    const second = withRepoMutationLock(SELECTION, '/work/linked', () => {
      log.push('linked:enter');
      return Promise.resolve();
    });

    releaseFirst();
    await Promise.all([first, second]);

    expect(log).toEqual(['main:enter', 'main:exit', 'linked:enter']);
  });

  it('lets two different repositories overlap', async () => {
    const { withRepoMutationLock } = lockFor('posix');
    const log: string[] = [];
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withRepoMutationLock(SELECTION, '/other-repo', async () => {
      log.push('other:enter');
      await firstHeld;
    });
    await Promise.resolve();
    const second = withRepoMutationLock(SELECTION, '/repo', () => {
      log.push('repo:enter');
      return Promise.resolve();
    });

    await second;
    expect(log).toContain('repo:enter');

    releaseFirst();
    await first;
  });
});
