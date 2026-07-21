import { describe, expect, it } from 'bun:test';
import {
  GIT_LOG_FORMAT,
  parseCommitFiles,
  parseHistoryLog,
} from '../../../../src/modules/git/domain/history-parser';

describe('history parser', () => {
  it('parses commit metadata, refs, and numstat totals', () => {
    expect(GIT_LOG_FORMAT).toContain('%x1e%H');
    const commits = parseHistoryLog(
      '\x1eabcdef1234567890\x1fabcdef1\x1fShip history\x1fMango Dev\x1f2026-07-21T10:00:00Z\x1fHEAD -> main, tag: v1\n' +
        '4\t1\tsrc/file.ts\n-\t-\timage.png\n'
    );

    expect(commits).toEqual([
      {
        hash: 'abcdef1234567890',
        shortHash: 'abcdef1',
        subject: 'Ship history',
        author: 'Mango Dev',
        authoredAt: '2026-07-21T10:00:00Z',
        refs: ['HEAD -> main', 'tag: v1'],
        changedFiles: 2,
        additions: 4,
        deletions: 1,
      },
    ]);
  });

  it('joins rename status with the destination numstat path', () => {
    expect(
      parseCommitFiles(
        'R100\0src/old.ts\0src/new.ts\0A\0src/added.ts\0',
        '2\t1\t\0src/old.ts\0src/new.ts\0' + '3\t0\tsrc/added.ts\0'
      )
    ).toEqual([
      {
        path: 'src/new.ts',
        oldPath: 'src/old.ts',
        status: 'renamed',
        additions: 2,
        deletions: 1,
      },
      { path: 'src/added.ts', status: 'added', additions: 3, deletions: 0 },
    ]);
  });
});
