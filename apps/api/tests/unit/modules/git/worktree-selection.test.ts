import { describe, expect, it } from 'bun:test';
import type { GitWorktree } from '@mangostudio/shared/git';
import {
  findWorktree,
  isSameWorktreePath,
} from '../../../../src/modules/git/domain/worktree-selection';

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
    expect(findWorktree(worktrees, '/repo', '/work/feature')?.path).toBe('/work/feature');
  });

  it('matches through a trailing separator and a dot segment', () => {
    expect(findWorktree(worktrees, '/repo', '/work/./feature/')?.path).toBe('/work/feature');
  });

  it('resolves a relative path against the repository root, as Git would', () => {
    expect(findWorktree(worktrees, '/repo', '../work/feature')?.path).toBe('/work/feature');
  });

  it('refuses a partial name instead of guessing a worktree', () => {
    expect(findWorktree(worktrees, '/repo', 'feature')).toBeUndefined();
    expect(findWorktree(worktrees, '/repo', '/work/feature-two')).toBeUndefined();
  });
});

describe('isSameWorktreePath', () => {
  it('sees through separators and dot segments', () => {
    expect(isSameWorktreePath('/work/feature/', '/work/./feature')).toBe(true);
  });

  it('keeps distinct worktrees distinct', () => {
    expect(isSameWorktreePath('/work/feature', '/work/feature-two')).toBe(false);
  });

  it('leaves the filesystem root alone', () => {
    expect(isSameWorktreePath('/', '/')).toBe(true);
  });
});
