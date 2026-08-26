import { describe, expect, it } from 'bun:test';
import type { GitWorktree } from '@mangostudio/shared/git';
import {
  findWorktree,
  isSameWorktreePath,
  type WorktreePathSemantics,
} from '../../../../src/modules/git/domain/worktree-selection';
import { createTargetPaths } from '../../../../src/services/runtime-client/target-paths';

/**
 * The real `TargetPaths` for each platform, not a stub: the reason these
 * functions take path semantics at all is that the hub and the runtime can be
 * different platforms, and a stub would test the hub's own `node:path` again.
 */
function pathsFor(pathStyle: 'posix' | 'win32'): WorktreePathSemantics {
  return createTargetPaths({
    pathStyle,
    homeDir: pathStyle === 'win32' ? 'C:\\Users\\dev' : '/home/dev',
  } as Parameters<typeof createTargetPaths>[0]);
}

const posixPaths = pathsFor('posix');

function worktree(path: string, overrides: Partial<GitWorktree> = {}): GitWorktree {
  return {
    path,
    head: '0a44a0f9bbf9a15117d5bbc4d543442f2b169d87',
    branch: 'main',
    isMain: false,
    isBare: false,
    isDetached: false,
    isLocked: false,
    isPrunable: false,
    ...overrides,
  };
}

const worktrees = [worktree('/repo', { isMain: true }), worktree('/work/feature')];

describe('findWorktree', () => {
  it('matches an exact absolute path', () => {
    expect(findWorktree(worktrees, '/repo', '/work/feature', posixPaths)?.path).toBe(
      '/work/feature'
    );
  });

  it('matches through a trailing separator and a dot segment', () => {
    expect(findWorktree(worktrees, '/repo', '/work/./feature/', posixPaths)?.path).toBe(
      '/work/feature'
    );
  });

  it('resolves a relative path against the repository root, as Git would', () => {
    expect(findWorktree(worktrees, '/repo', '../work/feature', posixPaths)?.path).toBe(
      '/work/feature'
    );
  });

  it('refuses a partial name instead of guessing a worktree', () => {
    expect(findWorktree(worktrees, '/repo', 'feature', posixPaths)).toBeUndefined();
    expect(findWorktree(worktrees, '/repo', '/work/feature-two', posixPaths)).toBeUndefined();
  });

  /**
   * The regression the `paths` parameter exists for. These are paths on the
   * *runtime*, and the hub can be a different platform — a Windows hub reading
   * a WSL repository through its own `node:path` normalized the listed path to
   * `\home\u\wt` while `resolve` prefixed the hub's drive, so nothing ever
   * matched and every remove answered 404.
   *
   * Asserted from the Windows-runtime direction because it is the one that
   * holds on any host: a hub-platform assertion would only reproduce the
   * failure when the suite itself runs on Windows.
   */
  it('matches a Windows runtime\u2019s paths only under Windows semantics', () => {
    const windowsWorktrees = [worktree('C:\\work\\feature')];
    const windowsPaths = pathsFor('win32');

    expect(
      findWorktree(windowsWorktrees, 'C:\\repo', 'C:\\work\\.\\feature\\', windowsPaths)?.path
    ).toBe('C:\\work\\feature');
    expect(
      findWorktree(windowsWorktrees, 'C:\\repo', '..\\work\\feature', windowsPaths)?.path
    ).toBe('C:\\work\\feature');
    // The same repository read with the wrong platform's rules finds nothing.
    expect(
      findWorktree(windowsWorktrees, 'C:\\repo', 'C:\\work\\.\\feature\\', posixPaths)
    ).toBeUndefined();
  });
});

describe('isSameWorktreePath', () => {
  it('sees through separators and dot segments', () => {
    expect(isSameWorktreePath('/work/feature/', '/work/./feature', posixPaths)).toBe(true);
  });

  it('keeps distinct worktrees distinct', () => {
    expect(isSameWorktreePath('/work/feature', '/work/feature-two', posixPaths)).toBe(false);
  });

  it('leaves the filesystem root alone', () => {
    expect(isSameWorktreePath('/', '/', posixPaths)).toBe(true);
  });
});
