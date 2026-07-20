import { describe, expect, it } from 'bun:test';
import {
  createGithubContextService,
  GithubContextError,
} from '../../../../src/modules/github/application/github-context-service';
import { GhCliError, type GithubCli } from '../../../../src/modules/github/infrastructure/gh-cli';

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
const result = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });

function fakeCli(overrides: Partial<GithubCli> = {}): GithubCli {
  return {
    isAvailable: () => Promise.resolve(true),
    isAuthenticated: () => Promise.resolve(true),
    viewRepo: () => Promise.resolve(result(repoOutput)),
    viewCurrentPr: () => Promise.resolve(result(prOutput)),
    ...overrides,
  };
}

describe('GitHub context service', () => {
  it('short-circuits installation and authentication states', async () => {
    const unavailable = createGithubContextService(
      fakeCli({ isAvailable: () => Promise.resolve(false) })
    );
    await expect(unavailable('/repo')).resolves.toEqual({ state: 'gh-not-installed' });

    const unauthenticated = createGithubContextService(
      fakeCli({ isAuthenticated: () => Promise.resolve(false) })
    );
    await expect(unauthenticated('/repo')).resolves.toEqual({ state: 'not-authenticated' });
  });

  it('maps repository discovery errors to stable context states', async () => {
    const noRemote = createGithubContextService(
      fakeCli({
        viewRepo: () => Promise.reject(new GhCliError(['repo', 'view'], 1, 'no git remotes found')),
      })
    );
    await expect(noRemote('/repo')).resolves.toEqual({ state: 'no-remote' });

    const notGithub = createGithubContextService(
      fakeCli({
        viewRepo: () =>
          Promise.reject(
            new GhCliError(
              ['repo', 'view'],
              1,
              'none of the git remotes configured for this repository point to a known GitHub host'
            )
          ),
      })
    );
    await expect(notGithub('/repo')).resolves.toEqual({ state: 'not-a-github-remote' });
  });

  it('returns repository context with and without a branch pull request', async () => {
    const withPr = createGithubContextService(fakeCli());
    await expect(withPr('/repo')).resolves.toEqual({
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
        viewCurrentPr: () =>
          Promise.reject(
            new GhCliError(['pr', 'view'], 1, 'no pull requests found for branch "feat/no-pr"')
          ),
      })
    );
    await expect(withoutPr('/repo')).resolves.toMatchObject({ state: 'ok', pr: null });
  });

  it('rejects malformed and schema-incompatible JSON as typed output errors', async () => {
    const malformed = createGithubContextService(
      fakeCli({ viewRepo: () => Promise.resolve(result('{not-json')) })
    );
    await expect(malformed('/repo')).rejects.toBeInstanceOf(GithubContextError);

    const invalidPr = createGithubContextService(
      fakeCli({ viewCurrentPr: () => Promise.resolve(result('{"number":0}')) })
    );
    await expect(invalidPr('/repo')).rejects.toMatchObject({
      name: 'GithubContextError',
      code: 'GH_OUTPUT_INVALID',
      command: 'pr view',
    });
  });

  it('does not downgrade unexpected gh failures into normal states', async () => {
    const failure = new GhCliError(['repo', 'view'], 1, 'network unavailable');
    const service = createGithubContextService(
      fakeCli({ viewRepo: () => Promise.reject(failure) })
    );
    await expect(service('/repo')).rejects.toBe(failure);
  });
});
