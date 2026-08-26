import { describe, expect, it } from 'bun:test';
import { resolveGitCommonDir } from '../../../../src/modules/git/domain/git-common-dir';

describe('resolveGitCommonDir', () => {
  it('resolves the relative answer the main worktree gives against its root', () => {
    expect(resolveGitCommonDir('/repo', '.git\n')).toBe('/repo/.git');
  });

  it('keeps the absolute answer a linked worktree gives', () => {
    expect(resolveGitCommonDir('/work/linked', '/repo/.git\n')).toBe('/repo/.git');
  });

  it('gives one key for both worktrees of a repository', () => {
    // The whole point: a `worktree add` issued from the main worktree and one
    // issued from a linked worktree must take the same mutation lock.
    expect(resolveGitCommonDir('/repo', '.git')).toBe(
      resolveGitCommonDir('/work/linked', '/repo/.git')
    );
  });

  it('normalizes traversal so two spellings of one directory agree', () => {
    expect(resolveGitCommonDir('/repo/sub/..', '.git')).toBe(
      resolveGitCommonDir('/repo', './.git')
    );
  });

  it('throws instead of silently falling back when Git answers with nothing', () => {
    expect(() => resolveGitCommonDir('/repo', '  \n')).toThrow(TypeError);
  });
});
