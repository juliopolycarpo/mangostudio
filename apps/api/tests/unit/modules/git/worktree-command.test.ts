import { describe, expect, it } from 'bun:test';
import {
  buildWorktreeAddArgs,
  buildWorktreeRemoveArgs,
  GitWorktreeArgumentError,
} from '../../../../src/modules/git/domain/worktree-command';

describe('buildWorktreeAddArgs', () => {
  it('creates a branch with -b before the path separator', () => {
    expect(
      buildWorktreeAddArgs({ path: '/work/feature', mode: 'new-branch', branch: 'feat/panel' })
    ).toEqual(['worktree', 'add', '-b', 'feat/panel', '--', '/work/feature']);
  });

  it('checks an existing branch out as a positional after the separator', () => {
    expect(
      buildWorktreeAddArgs({ path: '/work/feature', mode: 'existing-branch', branch: 'feat/panel' })
    ).toEqual(['worktree', 'add', '--', '/work/feature', 'feat/panel']);
  });

  it('refuses a path Git would read as an option', () => {
    expect(() =>
      buildWorktreeAddArgs({ path: '--force', mode: 'new-branch', branch: 'feat/x' })
    ).toThrow(GitWorktreeArgumentError);
    expect(() =>
      buildWorktreeAddArgs({ path: '-b', mode: 'existing-branch', branch: 'feat/x' })
    ).toThrow(GitWorktreeArgumentError);
  });

  it('refuses a branch name Git would read as an option, in either mode', () => {
    // `-b` takes its value before `--`, so a dashed new-branch name has no
    // separator to hide behind and must be rejected outright.
    expect(() =>
      buildWorktreeAddArgs({ path: '/work/x', mode: 'new-branch', branch: '--detach' })
    ).toThrow(GitWorktreeArgumentError);
    expect(() =>
      buildWorktreeAddArgs({ path: '/work/x', mode: 'existing-branch', branch: '-D' })
    ).toThrow(GitWorktreeArgumentError);
  });

  it('refuses a bare separator, which would shift every positional after it', () => {
    expect(() =>
      buildWorktreeAddArgs({ path: '--', mode: 'existing-branch', branch: 'main' })
    ).toThrow(GitWorktreeArgumentError);
  });
});

describe('buildWorktreeRemoveArgs', () => {
  it('separates the path from the options', () => {
    expect(buildWorktreeRemoveArgs({ path: '/work/feature' })).toEqual([
      'worktree',
      'remove',
      '--',
      '/work/feature',
    ]);
  });

  it('adds a single --force, never the double form that overrides a lock', () => {
    const args = buildWorktreeRemoveArgs({ path: '/work/feature', force: true });

    expect(args).toEqual(['worktree', 'remove', '--force', '--', '/work/feature']);
    expect(args.filter((arg) => arg === '--force')).toHaveLength(1);
  });

  it('refuses a dashed path with and without force', () => {
    expect(() => buildWorktreeRemoveArgs({ path: '-f' })).toThrow(GitWorktreeArgumentError);
    expect(() => buildWorktreeRemoveArgs({ path: '--', force: true })).toThrow(
      GitWorktreeArgumentError
    );
  });
});
