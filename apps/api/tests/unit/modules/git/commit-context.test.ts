import { describe, expect, it } from 'bun:test';
import type { GitStatus } from '@mangostudio/shared/git';
import {
  buildCommitContext,
  buildCommitContextWithMetadata,
  DIFF_TRUNCATED_MARKER,
} from '../../../../src/modules/git/application/commit-context';

const cleanBranch = { name: 'main', ahead: 0, behind: 0 } as const;

function status(overrides: Partial<GitStatus>): GitStatus {
  return {
    branch: cleanBranch,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    clean: false,
    ...overrides,
  };
}

describe('buildCommitContext', () => {
  it('selects only the staged diff when the index contains changes', () => {
    const context = buildCommitContext({
      status: status({ staged: [{ path: 'staged.ts', status: 'modified' }] }),
      stagedDiff: 'diff --git a/staged.ts b/staged.ts\n+staged content',
      unstagedDiff: 'diff --git a/unstaged.ts b/unstaged.ts\n+unstaged content',
      recentSubjects: ['feat(git): add repository panel'],
      maxDiffBytes: 16 * 1024,
    });

    expect(context).toContain('Selected diff (staged)');
    expect(context).toContain('staged content');
    expect(context).not.toContain('unstaged content');
    expect(context).toContain('feat(git): add repository panel');
  });

  it('uses the unstaged diff and lists untracked names when the index is empty', () => {
    const context = buildCommitContext({
      status: status({
        unstaged: [{ path: 'tracked.ts', status: 'modified' }],
        untracked: [{ path: 'new.ts', status: 'untracked' }],
      }),
      stagedDiff: '',
      unstagedDiff: 'diff --git a/tracked.ts b/tracked.ts\n+worktree content',
      recentSubjects: [],
      maxDiffBytes: 16 * 1024,
    });

    expect(context).toContain('Selected diff (unstaged)');
    expect(context).toContain('worktree content');
    expect(context).toContain('Untracked files (content not included):\n- new.ts');
  });

  it('shares a clipped byte budget across files and never emits a partial hunk header', () => {
    const firstPrefix = 'diff --git a/first.ts b/first.ts\n--- a/first.ts\n+++ b/first.ts\n';
    const secondPrefix = 'diff --git a/second.ts b/second.ts\n--- a/second.ts\n+++ b/second.ts\n';
    const hunkHeader = '@@ -1,200 +1,200 @@ longFunctionName';
    const stagedDiff = `${firstPrefix}${hunkHeader}\n${'+first line\n'.repeat(80)}${secondPrefix}${hunkHeader}\n${'+second line\n'.repeat(80)}`;
    const context = buildCommitContextWithMetadata({
      status: status({
        staged: [
          { path: 'first.ts', status: 'modified' },
          { path: 'second.ts', status: 'modified' },
        ],
      }),
      stagedDiff,
      unstagedDiff: '',
      recentSubjects: [],
      maxDiffBytes: 220,
    });

    expect(context.truncated).toBe(true);
    expect(context.context).toContain('diff --git a/first.ts b/first.ts');
    expect(context.context).toContain('diff --git a/second.ts b/second.ts');
    expect(context.context).toContain(DIFF_TRUNCATED_MARKER);
    for (const line of context.context.split('\n').filter((line) => line.startsWith('@@'))) {
      expect(line).toBe(hunkHeader);
    }
  });

  it('lists binary files without embedding binary patch data', () => {
    const context = buildCommitContext({
      status: status({ staged: [{ path: 'asset.png', status: 'modified' }] }),
      stagedDiff:
        'diff --git a/asset.png b/asset.png\nnew file mode 100644\nindex 000..111\nGIT binary patch\nliteral 100\nsensitive-patch-data',
      unstagedDiff: '',
      recentSubjects: [],
      maxDiffBytes: 16 * 1024,
    });

    expect(context).toContain('[binary file: asset.png]');
    expect(context).not.toContain('sensitive-patch-data');
  });
});
