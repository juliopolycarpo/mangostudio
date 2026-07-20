import { describe, expect, it } from 'bun:test';
import { parseGitStatus } from '../../../../src/modules/git/domain/status-parser';

const HASH = '0123456789012345678901234567890123456789';

function fixture(...records: string[]): string {
  return `${records.join('\0')}\0`;
}

function branch(...records: string[]): string[] {
  return [`# branch.oid ${HASH}`, '# branch.head main', ...records];
}

function ordinary(xy: string, path: string): string {
  return `1 ${xy} N... 100644 100644 100644 ${HASH} ${HASH} ${path}`;
}

function renamed(xy: string, path: string): string {
  return `2 ${xy} N... 100644 100644 100644 ${HASH} ${HASH} R100 ${path}`;
}

describe('parseGitStatus', () => {
  it('parses a clean branch', () => {
    expect(parseGitStatus(fixture(...branch()))).toEqual({
      branch: { name: 'main', ahead: 0, behind: 0 },
      staged: [],
      unstaged: [],
      untracked: [],
      conflicted: [],
      clean: true,
    });
  });

  it('keeps staged and unstaged changes for the same file', () => {
    const status = parseGitStatus(fixture(...branch(ordinary('MM', 'src/index.ts'))));

    expect(status.staged).toEqual([{ path: 'src/index.ts', status: 'modified' }]);
    expect(status.unstaged).toEqual([{ path: 'src/index.ts', status: 'modified' }]);
    expect(status.clean).toBe(false);
  });

  it('pairs NUL-delimited rename paths', () => {
    const status = parseGitStatus(
      fixture(...branch(renamed('R.', 'src/new name.ts'), 'src/old name.ts'))
    );

    expect(status.staged).toEqual([
      { path: 'src/new name.ts', oldPath: 'src/old name.ts', status: 'renamed' },
    ]);
  });

  it('parses copied paths and the tab-paired compatibility form', () => {
    const copied = `2 C. N... 100644 100644 100644 ${HASH} ${HASH} C100 copy.ts\tsource.ts`;
    const status = parseGitStatus(fixture(...branch(copied)));

    expect(status.staged).toEqual([{ path: 'copy.ts', oldPath: 'source.ts', status: 'copied' }]);
  });

  it('groups unmerged entries as conflicts', () => {
    const unmerged = `u UU N... 100644 100644 100644 100644 ${HASH} ${HASH} ${HASH} conflict.ts`;
    const status = parseGitStatus(fixture(...branch(unmerged)));

    expect(status.conflicted).toEqual([{ path: 'conflict.ts', status: 'conflicted' }]);
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toEqual([]);
  });

  it('describes a detached HEAD by its object id', () => {
    const status = parseGitStatus(fixture(`# branch.oid ${HASH}`, '# branch.head (detached)'));

    expect(status.branch).toEqual({ name: null, detachedAt: HASH, ahead: 0, behind: 0 });
  });

  it('parses upstream ahead and behind counts', () => {
    const status = parseGitStatus(
      fixture(...branch('# branch.upstream origin/main', '# branch.ab +3 -2'))
    );

    expect(status.branch).toEqual({
      name: 'main',
      upstream: 'origin/main',
      ahead: 3,
      behind: 2,
    });
  });

  it('marks an untracked-only tree as dirty', () => {
    const status = parseGitStatus(fixture(...branch('? notes with spaces.txt')));

    expect(status.untracked).toEqual([{ path: 'notes with spaces.txt', status: 'untracked' }]);
    expect(status.clean).toBe(false);
  });

  it('maps type changes in both index and worktree positions', () => {
    const status = parseGitStatus(fixture(...branch(ordinary('TT', 'linked-file'))));

    expect(status.staged[0]?.status).toBe('type-changed');
    expect(status.unstaged[0]?.status).toBe('type-changed');
  });
});
