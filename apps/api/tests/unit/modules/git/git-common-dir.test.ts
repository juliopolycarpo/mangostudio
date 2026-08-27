import { describe, expect, it } from 'bun:test';
import { resolveGitCommonDir } from '../../../../src/modules/git/domain/git-common-dir';
import type { WorktreePathSemantics } from '../../../../src/modules/git/domain/worktree-selection';
import { createTargetPaths } from '../../../../src/services/runtime-client/target-paths';

/**
 * The real `TargetPaths` for each platform, not a stub — see
 * `worktree-selection.test.ts` for why: the reason this takes path semantics
 * at all is that the hub and the runtime can be different platforms, and a
 * stub would test the hub's own `node:path` again.
 */
function pathsFor(pathStyle: 'posix' | 'win32'): WorktreePathSemantics {
  return createTargetPaths({
    pathStyle,
    homeDir: pathStyle === 'win32' ? 'C:\\Users\\dev' : '/home/dev',
  } as Parameters<typeof createTargetPaths>[0]);
}

const posixPaths = pathsFor('posix');
const windowsPaths = pathsFor('win32');

describe('resolveGitCommonDir', () => {
  it('resolves the relative answer the main worktree gives against its root', () => {
    expect(resolveGitCommonDir('/repo', '.git\n', posixPaths)).toBe('/repo/.git');
  });

  it('keeps the absolute answer a linked worktree gives', () => {
    expect(resolveGitCommonDir('/work/linked', '/repo/.git\n', posixPaths)).toBe('/repo/.git');
  });

  it('gives one key for both worktrees of a repository', () => {
    // The whole point: a `worktree add` issued from the main worktree and one
    // issued from a linked worktree must take the same mutation lock.
    expect(resolveGitCommonDir('/repo', '.git', posixPaths)).toBe(
      resolveGitCommonDir('/work/linked', '/repo/.git', posixPaths)
    );
  });

  it('normalizes traversal so two spellings of one directory agree', () => {
    expect(resolveGitCommonDir('/repo/sub/..', '.git', posixPaths)).toBe(
      resolveGitCommonDir('/repo', './.git', posixPaths)
    );
  });

  it('throws instead of silently falling back when Git answers with nothing', () => {
    expect(() => resolveGitCommonDir('/repo', '  \n', posixPaths)).toThrow(TypeError);
  });

  /**
   * The regression `paths` exists to fix. Resolved through the hub's own
   * `node:path` — always posix on a Linux or WSL hub — `C:\repo\.git` reads as
   * *relative* rather than absolute, so a Windows runtime's linked-worktree
   * answer would join onto the root instead of standing on its own, and the
   * main worktree's `.git` answer and the linked worktree's absolute answer
   * would land on two different lock keys for one shared repository. Asserted
   * from the Windows-runtime direction so it holds on any host running the
   * suite, not only on Windows.
   */
  it('gives one key for both worktrees of a Windows-runtime repository', () => {
    expect(resolveGitCommonDir('C:\\repo', '.git', windowsPaths)).toBe(
      resolveGitCommonDir('C:\\work\\linked', 'C:\\repo\\.git', windowsPaths)
    );
  });
});
