import { describe, expect, it } from 'bun:test';
import { buildCommitArgs } from '../../../../src/modules/git/domain/commit-command';

describe('buildCommitArgs', () => {
  const booleans = [false, true] as const;

  for (const hasBody of booleans) {
    for (const amend of booleans) {
      for (const signOff of booleans) {
        for (const signCommits of booleans) {
          it(`assembles body=${hasBody}, amend=${amend}, signOff=${signOff}, signCommits=${signCommits}`, () => {
            const args = buildCommitArgs({
              title: 'subject',
              body: hasBody ? 'body text' : undefined,
              amend,
              signOff,
              signCommits,
            });

            expect(args).toEqual([
              'commit',
              '-m',
              'subject',
              ...(hasBody ? ['-m', 'body text'] : []),
              ...(amend ? ['--amend'] : []),
              ...(signOff ? ['--signoff'] : []),
              ...(signCommits ? ['--gpg-sign'] : []),
            ]);
          });
        }
      }
    }
  }
});
