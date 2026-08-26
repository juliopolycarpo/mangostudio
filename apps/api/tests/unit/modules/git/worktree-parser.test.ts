import { describe, expect, it } from 'bun:test';
import { parseWorktreeList } from '../../../../src/modules/git/domain/worktree-parser';

/** Builds the `-z` framing Git emits: NUL after every field, empty field ends the record. */
function porcelain(...records: string[][]): string {
  return records.map((fields) => `${fields.map((field) => `${field}\0`).join('')}\0`).join('');
}

describe('parseWorktreeList', () => {
  it('reads the main worktree and a linked one, shortening the branch ref', () => {
    const output = porcelain(
      ['worktree /repo', 'HEAD 99c46db7cdbd8d1ffea57fc350122cb45991c762', 'branch refs/heads/main'],
      [
        'worktree /work/feature one',
        'HEAD ddaf56aff864ddd08d1054148dfa51a893eecd69',
        'branch refs/heads/feat/panel',
      ]
    );

    expect(parseWorktreeList(output)).toEqual([
      {
        path: '/repo',
        head: '99c46db7cdbd8d1ffea57fc350122cb45991c762',
        branch: 'main',
        isMain: true,
        isBare: false,
        isDetached: false,
        isLocked: false,
        isPrunable: false,
      },
      {
        path: '/work/feature one',
        head: 'ddaf56aff864ddd08d1054148dfa51a893eecd69',
        branch: 'feat/panel',
        isMain: false,
        isBare: false,
        isDetached: false,
        isLocked: false,
        isPrunable: false,
      },
    ]);
  });

  it('reports a detached worktree with a commit but no branch', () => {
    const output = porcelain(
      ['worktree /repo', 'HEAD 0a44a0f9bbf9a15117d5bbc4d543442f2b169d87', 'branch refs/heads/main'],
      ['worktree /work/det', 'HEAD 0a44a0f9bbf9a15117d5bbc4d543442f2b169d87', 'detached']
    );

    expect(parseWorktreeList(output)[1]).toMatchObject({
      path: '/work/det',
      branch: null,
      isDetached: true,
    });
  });

  it('reports a bare repository, which carries neither HEAD nor branch', () => {
    expect(parseWorktreeList(porcelain(['worktree /repo.git', 'bare']))).toEqual([
      {
        path: '/repo.git',
        head: null,
        branch: null,
        isMain: true,
        isBare: true,
        isDetached: false,
        isLocked: false,
        isPrunable: false,
      },
    ]);
  });

  it('keeps a lock reason that spans lines, and reports a bare lock without one', () => {
    const output = porcelain(
      ['worktree /repo', 'HEAD 0a44a0f9bbf9a15117d5bbc4d543442f2b169d87', 'branch refs/heads/main'],
      ['worktree /work/held', 'detached', 'locked held for\nreview'],
      ['worktree /work/quiet', 'detached', 'locked']
    );
    const worktrees = parseWorktreeList(output);

    expect(worktrees[1]).toMatchObject({ isLocked: true, lockReason: 'held for\nreview' });
    expect(worktrees[2]?.isLocked).toBe(true);
    expect(worktrees[2]).not.toHaveProperty('lockReason');
  });

  it('reports a prunable worktree with the reason Git gave', () => {
    const output = porcelain([
      'worktree /work/gone',
      'HEAD 0a44a0f9bbf9a15117d5bbc4d543442f2b169d87',
      'branch refs/heads/feature',
      'prunable gitdir file points to non-existent location',
    ]);

    expect(parseWorktreeList(output)[0]).toMatchObject({
      isPrunable: true,
      prunableReason: 'gitdir file points to non-existent location',
    });
  });

  it('frames records by the NUL terminator, so a newline in a path stays in the path', () => {
    const output = porcelain([
      'worktree /work/new\nline',
      'HEAD 0a44a0f9bbf9a15117d5bbc4d543442f2b169d87',
      'branch refs/heads/nl',
    ]);

    expect(parseWorktreeList(output)[0]?.path).toBe('/work/new\nline');
  });

  it('skips records that do not open with a worktree path', () => {
    const output = porcelain(
      ['HEAD 0a44a0f9bbf9a15117d5bbc4d543442f2b169d87'],
      ['worktree '],
      ['worktree /repo', 'HEAD 0a44a0f9bbf9a15117d5bbc4d543442f2b169d87', 'branch refs/heads/main']
    );

    expect(parseWorktreeList(output)).toEqual([
      {
        path: '/repo',
        head: '0a44a0f9bbf9a15117d5bbc4d543442f2b169d87',
        branch: 'main',
        // The two skipped records never claimed the flag, so the first real one keeps it.
        isMain: true,
        isBare: false,
        isDetached: false,
        isLocked: false,
        isPrunable: false,
      },
    ]);
  });

  it('drops a HEAD that is not a commit hash rather than failing the whole list', () => {
    const output = porcelain(['worktree /repo', 'HEAD (unknown)', 'branch refs/heads/main']);

    expect(parseWorktreeList(output)[0]?.head).toBeNull();
  });

  it('accepts a trailing record that was never terminated', () => {
    const output = `${porcelain(['worktree /repo', 'branch refs/heads/main'])}worktree /work/tail\0`;

    expect(parseWorktreeList(output).map((worktree) => worktree.path)).toEqual([
      '/repo',
      '/work/tail',
    ]);
  });

  it('returns an empty list for empty output', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });
});
