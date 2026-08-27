import { describe, expect, it } from 'bun:test';
import { createGithubCache } from '../../../../src/modules/github/application/github-cache';
import { createGithubReadService } from '../../../../src/modules/github/application/github-read-service';
import { GhCliError } from '../../../../src/modules/github/infrastructure/gh-cli';
import { FakeGithubCli } from '../../../support/mocks/fake-github-cli';

const SELECTION = { userId: 'user-1', environmentId: 'devbox' };
const WORKDIR = '/remote/repo';

const repoOutput = JSON.stringify({
  nameWithOwner: 'mango/mangostudio',
  defaultBranchRef: { name: 'main' },
  url: 'https://github.example/mango/mangostudio',
});

const prListOutput = JSON.stringify([
  {
    number: 7,
    title: 'Add the panel',
    url: 'https://github.example/mango/mangostudio/pull/7',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'feat/panel',
    baseRefName: 'main',
    updatedAt: '2026-08-20T10:00:00Z',
    author: { id: 'x', is_bot: false, login: 'octocat', name: 'Mona' },
    labels: [],
    reviewDecision: '',
    statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  },
]);

const searchOutput = JSON.stringify([
  {
    number: 12,
    title: 'Review me',
    url: 'https://github.example/other/repo/pull/12',
    state: 'open',
    isDraft: false,
    updatedAt: '2026-08-20T10:00:00Z',
    author: { id: 'x', is_bot: false, login: 'octocat' },
    labels: [],
    repository: { name: 'repo', nameWithOwner: 'other/repo' },
  },
]);

function createService(client: FakeGithubCli, now: () => number = () => 1_000) {
  return createGithubReadService({
    client,
    cache: createGithubCache({ now }),
    now,
    homeCwd: () => Promise.resolve('/remote/home'),
  });
}

const repoRequest = { workdir: WORKDIR, selection: SELECTION };

describe('GitHub read service', () => {
  it('lists pull requests with the repository and a cache stamp', async () => {
    const client = new FakeGithubCli({
      stdout: { 'repo.view': repoOutput, 'pr.list': prListOutput },
    });
    const reads = createService(client);

    const response = await reads.listPullRequests({ ...repoRequest, filter: 'open', limit: 20 });

    expect(response).toMatchObject({
      state: 'ok',
      cachedAt: 1_000,
      repo: { nameWithOwner: 'mango/mangostudio', defaultBranch: 'main' },
    });
    expect(response.state === 'ok' && response.prs[0]).toMatchObject({
      number: 7,
      reviewDecision: null,
      checks: { passed: 1, failed: 0, pending: 0, total: 1 },
    });
  });

  it('reports every non-ok state without ever running the command', async () => {
    const unavailable = createService(new FakeGithubCli({ available: false }));
    await expect(
      unavailable.listPullRequests({ ...repoRequest, filter: 'open', limit: 20 })
    ).resolves.toEqual({ state: 'gh-not-installed' });

    const unauthenticated = createService(new FakeGithubCli({ authenticated: false }));
    await expect(
      unauthenticated.listIssues({ ...repoRequest, filter: 'open', limit: 20 })
    ).resolves.toEqual({ state: 'not-authenticated' });

    const noRemote = createService(
      new FakeGithubCli({
        respond: {
          'repo.view': () =>
            Promise.reject(new GhCliError(['repo', 'view'], 1, 'no git remotes found')),
        },
      })
    );
    await expect(noRemote.getPullRequest({ ...repoRequest, number: 7 })).resolves.toEqual({
      state: 'no-remote',
    });
  });

  it('caches by user, machine, workdir, endpoint and filter', async () => {
    const client = new FakeGithubCli({
      stdout: { 'repo.view': repoOutput, 'pr.list': prListOutput },
    });
    const reads = createService(client);

    await reads.listPullRequests({ ...repoRequest, filter: 'open', limit: 20 });
    await reads.listPullRequests({ ...repoRequest, filter: 'open', limit: 20 });
    expect(client.ids()).toEqual(['repo.view', 'pr.list']);

    // A different filter, page size, workdir or machine is a different answer
    // and must not be served from the first one's entry.
    await reads.listPullRequests({ ...repoRequest, filter: 'mine', limit: 20 });
    await reads.listPullRequests({ ...repoRequest, filter: 'open', limit: 30 });
    await reads.listPullRequests({
      workdir: '/other',
      selection: SELECTION,
      filter: 'open',
      limit: 20,
    });
    await reads.listPullRequests({
      ...repoRequest,
      selection: { userId: 'user-1', environmentId: 'laptop' },
      filter: 'open',
      limit: 20,
    });

    expect(client.ids().filter((id) => id === 'pr.list')).toHaveLength(5);
  });

  it('expires a cached list after the TTL', async () => {
    let now = 1_000;
    const client = new FakeGithubCli({
      stdout: { 'repo.view': repoOutput, 'pr.list': prListOutput },
    });
    const reads = createService(client, () => now);

    await reads.listPullRequests({ ...repoRequest, filter: 'open', limit: 20 });
    now += 59_999;
    await reads.listPullRequests({ ...repoRequest, filter: 'open', limit: 20 });
    expect(client.ids().filter((id) => id === 'pr.list')).toHaveLength(1);

    now += 2;
    const refreshed = await reads.listPullRequests({ ...repoRequest, filter: 'open', limit: 20 });
    expect(client.ids().filter((id) => id === 'pr.list')).toHaveLength(2);
    expect(refreshed).toMatchObject({ cachedAt: 61_001 });
  });

  it('bypasses a still-fresh cache entry when the caller asks for a refresh', async () => {
    let now = 1_000;
    const client = new FakeGithubCli({
      stdout: { 'repo.view': repoOutput, 'pr.list': prListOutput },
    });
    const reads = createService(client, () => now);

    await reads.listPullRequests({ ...repoRequest, filter: 'open', limit: 20 });
    now += 1;
    // Well inside the 60s TTL — an ordinary repeat read would still be served
    // from the entry above, the way the TTL test right above this one shows.
    const forced = await reads.listPullRequests({
      ...repoRequest,
      filter: 'open',
      limit: 20,
      refresh: true,
    });
    expect(client.ids().filter((id) => id === 'pr.list')).toHaveLength(2);
    expect(forced).toMatchObject({ cachedAt: 1_001 });

    // The entry a forced read leaves behind is a normal one: the very next
    // read, unforced, is served from it rather than forcing again.
    now += 1;
    await reads.listPullRequests({ ...repoRequest, filter: 'open', limit: 20 });
    expect(client.ids().filter((id) => id === 'pr.list')).toHaveLength(2);
  });

  it('reads checks in one round trip and summarizes them from gh’s own buckets', async () => {
    const client = new FakeGithubCli({
      stdout: {
        'repo.view': repoOutput,
        'pr.checks': JSON.stringify([
          { name: 'build', bucket: 'pass', state: 'SUCCESS', link: '', workflow: 'CI' },
          { name: 'lint', bucket: 'fail', state: 'FAILURE', link: '', workflow: 'CI' },
          { name: 'e2e', bucket: 'skipping', state: 'SKIPPED', link: '', workflow: 'CI' },
        ]),
      },
    });
    const reads = createService(client);

    const response = await reads.getPullRequestChecks({ ...repoRequest, number: 7 });

    expect(response).toMatchObject({
      state: 'ok',
      summary: { passed: 1, failed: 1, pending: 0, total: 3 },
    });
    expect(client.ids()).toEqual(['repo.view', 'pr.checks']);
  });

  it('treats gh’s blank output for a pull request with no checks as an empty list', async () => {
    // `gh pr checks` exits 1 with nothing on stdout when a pull request has no
    // checks — the same exit code a failing check uses, which the spec accepts.
    const client = new FakeGithubCli({
      stdout: { 'repo.view': repoOutput, 'pr.checks': '\n' },
    });
    const reads = createService(client);

    await expect(reads.getPullRequestChecks({ ...repoRequest, number: 7 })).resolves.toMatchObject({
      state: 'ok',
      summary: { passed: 0, failed: 0, pending: 0, total: 0 },
      checks: [],
    });
  });

  it('refuses a pull request number gh could not resolve rather than reporting no checks', async () => {
    // A pull request that does not exist produces the *same* exit code and the
    // same blank stdout as one with no checks, so answering "no checks" for a
    // number nobody ever opened is a wrong answer wearing an ordinary shape.
    // gh separates them on stderr, which is the only signal short of a second
    // round trip.
    const client = new FakeGithubCli({
      stdout: { 'repo.view': repoOutput },
      respond: {
        'pr.checks': () => ({
          stdout: '',
          stderr:
            'GraphQL: Could not resolve to a PullRequest with the number of 999999. (repository.pullRequest)',
          exitCode: 1,
        }),
      },
    });
    const reads = createService(client);

    await expect(reads.getPullRequestChecks({ ...repoRequest, number: 999_999 })).rejects.toThrow(
      /unreadable output/i
    );
  });

  it('still reports no checks when gh says nothing at all on stderr', async () => {
    const client = new FakeGithubCli({
      stdout: { 'repo.view': repoOutput },
      respond: {
        'pr.checks': () => ({
          stdout: '',
          stderr: "no checks reported on the 'feat/x' branch",
          exitCode: 1,
        }),
      },
    });
    const reads = createService(client);

    await expect(reads.getPullRequestChecks({ ...repoRequest, number: 7 })).resolves.toMatchObject({
      state: 'ok',
      checks: [],
    });
  });

  it('splits owner and name for the pinned GraphQL document', async () => {
    const client = new FakeGithubCli({
      stdout: {
        'repo.view': repoOutput,
        'pr.review-threads': JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  totalCount: 1,
                  nodes: [
                    {
                      isResolved: false,
                      isOutdated: true,
                      path: 'a.ts',
                      line: null,
                      comments: {
                        totalCount: 1,
                        nodes: [{ author: { login: 'octocat' }, body: 'hi' }],
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
      },
    });
    const reads = createService(client);

    const response = await reads.getReviewThreads({ ...repoRequest, number: 7 });

    expect(response).toMatchObject({
      state: 'ok',
      threads: [{ line: null, isOutdated: true }],
      truncated: false,
    });
    expect(client.calls.at(-1)?.params).toEqual({
      owner: 'mango',
      name: 'mangostudio',
      number: 7,
    });
  });

  it('runs the inbox outside any repository, on the runtime’s own home directory', async () => {
    // `gh search prs` and `gh auth status` both work outside a git repository,
    // so the inbox needs a machine and a directory that exists there — not a
    // workdir, and not a remote.
    const client = new FakeGithubCli({ stdout: { 'search.prs': searchOutput } });
    const reads = createService(client);

    const response = await reads.getInbox({ selection: SELECTION, limit: 20 });

    expect(response).toMatchObject({
      state: 'ok',
      cachedAt: 1_000,
      items: [{ number: 12, state: 'OPEN', repository: { nameWithOwner: 'other/repo' } }],
    });
    expect(client.ids()).toEqual(['search.prs']);
    expect(client.calls[0]?.cwd).toBe('/remote/home');
  });

  it('reports an unauthenticated inbox without reaching a repository state', async () => {
    const reads = createService(new FakeGithubCli({ authenticated: false }));
    await expect(reads.getInbox({ selection: SELECTION, limit: 20 })).resolves.toEqual({
      state: 'not-authenticated',
    });
  });
});
