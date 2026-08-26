import { describe, expect, it } from 'bun:test';
import { createGithubContextService } from '../../../../src/modules/github/application/github-context-service';
import { GithubOutputError } from '../../../../src/modules/github/domain/gh-output';
import {
  GhCliError,
  type GhRuntimeSelection,
} from '../../../../src/modules/github/infrastructure/gh-cli';
import { FakeGithubCli, type FakeGithubCliOptions } from '../../../support/mocks/fake-github-cli';

const repoOutput = JSON.stringify({
  nameWithOwner: 'mango/mangostudio',
  defaultBranchRef: { name: 'main' },
  url: 'https://github.example/mango/mangostudio',
});
const prOutput = JSON.stringify({
  number: 42,
  title: 'Expose GitHub context',
  state: 'OPEN',
  isDraft: true,
  url: 'https://github.example/mango/mangostudio/pull/42',
  headRefName: 'feat/github-context',
  baseRefName: 'main',
});

/** The machine a chat is pinned to; every call below has to carry it. */
const REMOTE: GhRuntimeSelection = { userId: 'user-1', environmentId: 'devbox' };

function fakeCli(overrides: FakeGithubCliOptions = {}): FakeGithubCli {
  return new FakeGithubCli({
    ...overrides,
    stdout: { 'repo.view': repoOutput, 'pr.view-current': prOutput, ...overrides.stdout },
  });
}

const rejectWith = (error: Error) => () => Promise.reject(error);

describe('GitHub context service', () => {
  it('short-circuits installation and authentication states', async () => {
    const unavailable = createGithubContextService(fakeCli({ available: false }));
    await expect(unavailable('/repo', REMOTE)).resolves.toEqual({ state: 'gh-not-installed' });

    const unauthenticated = createGithubContextService(fakeCli({ authenticated: false }));
    await expect(unauthenticated('/repo', REMOTE)).resolves.toEqual({ state: 'not-authenticated' });
  });

  it('maps repository discovery errors to stable context states', async () => {
    const noRemote = createGithubContextService(
      fakeCli({
        respond: {
          'repo.view': rejectWith(new GhCliError(['repo', 'view'], 1, 'no git remotes found')),
        },
      })
    );
    await expect(noRemote('/repo', REMOTE)).resolves.toEqual({ state: 'no-remote' });

    const notGithub = createGithubContextService(
      fakeCli({
        respond: {
          'repo.view': rejectWith(
            new GhCliError(
              ['repo', 'view'],
              1,
              'none of the git remotes configured for this repository point to a known GitHub host'
            )
          ),
        },
      })
    );
    await expect(notGithub('/repo', REMOTE)).resolves.toEqual({ state: 'not-a-github-remote' });
  });

  it('returns repository context with and without a branch pull request', async () => {
    const withPr = createGithubContextService(fakeCli());
    await expect(withPr('/repo', REMOTE)).resolves.toEqual({
      state: 'ok',
      repo: {
        nameWithOwner: 'mango/mangostudio',
        defaultBranch: 'main',
        url: 'https://github.example/mango/mangostudio',
      },
      pr: JSON.parse(prOutput),
    });

    const withoutPr = createGithubContextService(
      fakeCli({
        respond: {
          'pr.view-current': rejectWith(
            new GhCliError(['pr', 'view'], 1, 'no pull requests found for branch "feat/no-pr"')
          ),
        },
      })
    );
    await expect(withoutPr('/repo', REMOTE)).resolves.toMatchObject({ state: 'ok', pr: null });
  });

  it('rejects malformed and schema-incompatible JSON as typed output errors', async () => {
    const malformed = createGithubContextService(fakeCli({ stdout: { 'repo.view': '{not-json' } }));
    await expect(malformed('/repo', REMOTE)).rejects.toBeInstanceOf(GithubOutputError);

    const invalidPr = createGithubContextService(
      fakeCli({ stdout: { 'pr.view-current': '{"number":0}' } })
    );
    await expect(invalidPr('/repo', REMOTE)).rejects.toMatchObject({
      name: 'GithubOutputError',
      code: 'GH_OUTPUT_INVALID',
      command: 'pr.view-current',
    });
  });

  it('runs gh on the environment the chat is pinned to', async () => {
    // The bug this service used to have: it knew a workdir and nothing about
    // whose machine that path was on, so a chat pinned to WSL, SSH, or a
    // container ran gh against the hub's filesystem and the hub's gh account.
    const client = fakeCli();
    const service = createGithubContextService(client);

    await service('/remote/repo', REMOTE);

    expect(client.ids()).toEqual(['repo.view', 'pr.view-current']);
    for (const call of client.calls) {
      expect(call.selection).toEqual(REMOTE);
      expect(call.cwd).toBe('/remote/repo');
    }
  });

  it('does not downgrade unexpected gh failures into normal states', async () => {
    const failure = new GhCliError(['repo', 'view'], 1, 'network unavailable');
    const service = createGithubContextService(
      fakeCli({ respond: { 'repo.view': rejectWith(failure) } })
    );
    await expect(service('/repo', REMOTE)).rejects.toBe(failure);
  });
});
