import { describe, expect, it } from 'bun:test';
import {
  parseBranchList,
  parseCheckoutBlockedPaths,
  parseRemoteBranchList,
} from '../../../../src/modules/git/domain/branch-parser';

describe('branch parser', () => {
  it('sorts the current branch first and reads tracking counts', () => {
    const branches = parseBranchList(
      'main\x1f \x1forigin/main\x1fbehind 2\0feat/work\x1f*\x1forigin/feat/work\x1fahead 3, behind 1\0'
    );

    expect(branches).toEqual([
      {
        name: 'feat/work',
        current: true,
        upstream: 'origin/feat/work',
        ahead: 3,
        behind: 1,
      },
      { name: 'main', current: false, upstream: 'origin/main', ahead: 0, behind: 2 },
    ]);
  });

  it('extracts tracked and untracked checkout conflicts', () => {
    expect(
      parseCheckoutBlockedPaths(
        [
          'error: Your local changes to the following files would be overwritten by checkout:',
          '\tsrc/panel.tsx',
          '\tREADME.md',
          'Please commit your changes or stash them before you switch branches.',
        ].join('\n')
      )
    ).toEqual(['src/panel.tsx', 'README.md']);
  });

  it('collects paths from every conflict block in one failure', () => {
    expect(
      parseCheckoutBlockedPaths(
        [
          'error: Your local changes to the following files would be overwritten by checkout:',
          '\tsrc/panel.tsx',
          'Please commit your changes or stash them before you switch branches.',
          'error: The following untracked working tree files would be overwritten by checkout:',
          '\tsrc/generated.ts',
          'Please move or remove them before you switch branches.',
          'Aborting',
        ].join('\n')
      )
    ).toEqual(['src/panel.tsx', 'src/generated.ts']);
  });

  it('parses remote-tracking refs and drops symbolic remote HEADs', () => {
    expect(parseRemoteBranchList('origin/HEAD\0origin/main\0upstream/feat/x\0')).toEqual([
      { name: 'main', remote: 'origin', ref: 'origin/main' },
      { name: 'feat/x', remote: 'upstream', ref: 'upstream/feat/x' },
    ]);
  });
});
