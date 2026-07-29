import { describe, expect, it } from 'bun:test';
import {
  buildCommitArgs,
  parseCommitterIdentity,
} from '../../../../src/modules/git/domain/commit-command';

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

  it('never opts out, so git config stays authoritative when a setting is off', () => {
    const args = buildCommitArgs({
      title: 'subject',
      amend: true,
      signOff: false,
      signCommits: false,
    });

    expect(args).not.toContain('--no-signoff');
    expect(args).not.toContain('--no-gpg-sign');
  });
});

describe('parseCommitterIdentity', () => {
  it('drops the timestamp git var appends', () => {
    expect(parseCommitterIdentity('Maintainer <maintainer@example.test> 1751328000 -0300\n')).toBe(
      'Maintainer <maintainer@example.test>'
    );
  });

  it('returns undefined when git has no identity to offer', () => {
    expect(parseCommitterIdentity('  \n')).toBeUndefined();
  });
});
