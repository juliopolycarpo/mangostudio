import { describe, expect, it } from 'bun:test';
import { createGithubCache } from '../../../../src/modules/github/application/github-cache';
import { createGithubReadService } from '../../../../src/modules/github/application/github-read-service';
import type { GithubWriteOperation } from '../../../../src/modules/github/application/github-realtime-service';
import { createGithubWriteService } from '../../../../src/modules/github/application/github-write-service';
import { GithubOutputError } from '../../../../src/modules/github/domain/gh-output';
import { GhCliError } from '../../../../src/modules/github/infrastructure/gh-cli';
import { FakeGithubCli } from '../../../support/mocks/fake-github-cli';

const SELECTION = { userId: 'user-1', environmentId: 'devbox' };
const REQUEST = { workdir: '/remote/repo', chatId: 'chat-1', selection: SELECTION };

const repoOutput = JSON.stringify({
  nameWithOwner: 'mango/mangostudio',
  defaultBranchRef: { name: 'main' },
  url: 'https://github.example/mango/mangostudio',
});

const summaryOutput = JSON.stringify({
  number: 7,
  title: 'Add the panel',
  url: 'https://github.example/mango/mangostudio/pull/7',
  state: 'OPEN',
  isDraft: false,
  headRefName: 'feat/panel',
  baseRefName: 'main',
  updatedAt: '2026-08-20T10:00:00Z',
  author: { id: 'x', is_bot: false, login: 'octocat' },
  labels: [],
  reviewDecision: '',
  statusCheckRollup: [],
});

interface Published {
  readonly chatId: string;
  readonly operation: GithubWriteOperation;
}

/**
 * `requireRepoRoot` and `withMutationLock` reach the runtime connection and
 * a shared queue keyed by (environment, root) respectively — real for the
 * checkout lock, but exactly what a unit test for the write service itself
 * should not have to stand up. `withMutationLock` here just runs the
 * mutation directly, since these tests are not the ones asserting ordering
 * against a concurrent git write.
 */
const noopRepoRootDeps = {
  requireRepoRoot: () => Promise.resolve('/remote/repo'),
  withMutationLock: <T>(_environmentId: string, _scope: string, mutation: () => Promise<T>) =>
    mutation(),
};

function createService(client: FakeGithubCli, published: Published[] = []) {
  return createGithubWriteService({
    client,
    cache: createGithubCache(),
    currentBranch: () => Promise.resolve('feat/panel'),
    pullRequestTemplate: () => Promise.resolve('## Summary\n\n## Test Plan\n- [ ] `bun run check`'),
    publish: (target, operation) => published.push({ chatId: target.chatId, operation }),
    ...noopRepoRootDeps,
  });
}

const createClient = () =>
  new FakeGithubCli({
    stdout: {
      'repo.view': repoOutput,
      'pr.create': 'https://github.example/mango/mangostudio/pull/7\n',
      'pr.view-summary': summaryOutput,
    },
  });

describe('GitHub write service', () => {
  it('opens a pull request and reads back the row the panel renders', async () => {
    // `gh pr create` prints a URL and nothing else, so the row the response
    // carries has to be read back — otherwise the panel refetches a page to
    // find out what it just did.
    const client = createClient();
    const writes = createService(client);

    const response = await writes.createPullRequest(REQUEST, {
      chatId: 'chat-1',
      title: 'Add the panel',
      body: 'Because.',
      draft: true,
      base: 'main',
    });

    expect(response).toMatchObject({
      state: 'ok',
      repo: { nameWithOwner: 'mango/mangostudio' },
      pr: { number: 7, reviewDecision: null },
    });
    expect(client.ids()).toEqual(['repo.view', 'pr.create', 'pr.view-summary']);
    expect(client.calls[1]?.params).toEqual({
      title: 'Add the panel',
      body: 'Because.',
      head: 'feat/panel',
      draft: true,
      base: 'main',
    });
  });

  it('always names the head branch, because a prompt cannot be answered', async () => {
    // gh prompts for where to push when the current branch is not fully pushed,
    // and the runner sets GH_PROMPT_DISABLED=1 — so that prompt is a failure.
    const client = createClient();
    const writes = createService(client);

    await writes.createPullRequest(REQUEST, { chatId: 'chat-1', title: 'T' });

    expect(client.calls[1]?.params).toMatchObject({ head: 'feat/panel', draft: false });
  });

  it('falls back to the repository template when the caller supplies no body', async () => {
    // `--template` is starting body text for the interactive editor and does
    // not combine with a non-interactive `--body`, so the template has to be
    // read and passed as body text.
    const client = createClient();
    const writes = createService(client);

    await writes.createPullRequest(REQUEST, { chatId: 'chat-1', title: 'T' });

    expect(client.calls[1]?.params).toMatchObject({
      body: '## Summary\n\n## Test Plan\n- [ ] `bun run check`',
    });
    expect(client.calls[1]?.params).not.toMatchObject({ template: expect.anything() });
  });

  it('marks a pull request ready and checks one out through the same path', async () => {
    for (const [action, operation] of [
      ['markPullRequestReady', 'ready'],
      ['checkoutPullRequest', 'checkout'],
    ] as const) {
      const client = createClient();
      const published: Published[] = [];
      const writes = createService(client, published);

      const response = await writes[action](REQUEST, { chatId: 'chat-1', number: 7 });

      expect(response).toMatchObject({
        state: 'ok',
        pr: { number: 7, headRefName: 'feat/panel', checks: { total: 0 } },
      });
      // No `repo` on an action response: the pull request is the whole answer,
      // and `pr.headRefName` is already the branch a checkout switched to.
      expect(response).not.toHaveProperty('repo');
      expect(client.ids()).toEqual([
        'repo.view',
        operation === 'ready' ? 'pr.ready' : 'pr.checkout',
        'pr.view-summary',
      ]);
      expect(published).toEqual([{ chatId: 'chat-1', operation }]);
    }
  });

  it('settles the cache and realtime state even when the readback after the mutation fails', async () => {
    // pr.ready / pr.checkout already changed something on GitHub or the
    // working tree by the time the convenience pr.view-summary readback runs.
    // If that readback is what aborts, times out, or returns unparseable
    // output, the cache and realtime subscribers must not be left holding the
    // pre-mutation state — that would report a failure for a write that
    // already succeeded, and invite the caller to retry it.
    for (const [action, operation] of [
      ['markPullRequestReady', 'ready'],
      ['checkoutPullRequest', 'checkout'],
    ] as const) {
      const client = new FakeGithubCli({
        stdout: { 'repo.view': repoOutput },
        respond: { 'pr.view-summary': () => Promise.reject(new Error('runtime aborted')) },
      });
      const cache = createGithubCache();
      const published: Published[] = [];
      const writes = createGithubWriteService({
        client,
        cache,
        currentBranch: () => Promise.resolve('feat/panel'),
        pullRequestTemplate: () => Promise.resolve(''),
        publish: (target, op) => published.push({ chatId: target.chatId, operation: op }),
        ...noopRepoRootDeps,
      });

      const before = await cache.read({ ...SELECTION, subject: 'inbox' }, 'v', () =>
        Promise.resolve({})
      );

      await expect(writes[action](REQUEST, { chatId: 'chat-1', number: 7 })).rejects.toBeInstanceOf(
        Error
      );

      expect(published).toEqual([{ chatId: 'chat-1', operation }]);
      const after = await cache.read({ ...SELECTION, subject: 'inbox' }, 'v', () =>
        Promise.resolve({})
      );
      expect(after).not.toBe(before);
    }
  });

  it('settles the cache and realtime state even when gh pr create prints an unparseable URL', async () => {
    const client = new FakeGithubCli({
      stdout: { 'repo.view': repoOutput, 'pr.create': 'Warning: something else entirely' },
    });
    const cache = createGithubCache();
    const published: Published[] = [];
    const writes = createGithubWriteService({
      client,
      cache,
      currentBranch: () => Promise.resolve('feat/panel'),
      pullRequestTemplate: () => Promise.resolve(''),
      publish: (target, op) => published.push({ chatId: target.chatId, operation: op }),
      ...noopRepoRootDeps,
    });

    const before = await cache.read({ ...SELECTION, subject: 'inbox' }, 'v', () =>
      Promise.resolve({})
    );

    await expect(
      writes.createPullRequest(REQUEST, { chatId: 'chat-1', title: 'T' })
    ).rejects.toBeInstanceOf(GithubOutputError);

    expect(published).toEqual([{ chatId: 'chat-1', operation: 'create' }]);
    const after = await cache.read({ ...SELECTION, subject: 'inbox' }, 'v', () =>
      Promise.resolve({})
    );
    expect(after).not.toBe(before);
  });

  it('drops the cached reads for that machine, so the list cannot lag the action', async () => {
    const client = createClient();
    const cache = createGithubCache();
    const reads = createGithubReadService({
      client: new FakeGithubCli({ stdout: { 'repo.view': repoOutput, 'pr.list': '[]' } }),
      cache,
      homeCwd: () => Promise.resolve('/remote/home'),
    });
    const writes = createGithubWriteService({
      client,
      cache,
      currentBranch: () => Promise.resolve('feat/panel'),
      pullRequestTemplate: () => Promise.resolve(''),
      publish: () => undefined,
      ...noopRepoRootDeps,
    });

    const listOnce = () =>
      reads.listPullRequests({
        workdir: '/remote/repo',
        selection: SELECTION,
        filter: 'open',
        limit: 20,
      });

    const before = await listOnce();
    expect(await listOnce()).toBe(before);

    await writes.markPullRequestReady(REQUEST, { chatId: 'chat-1', number: 7 });

    expect(await listOnce()).not.toBe(before);
  });

  it('reports a non-ok state instead of attempting the write', async () => {
    const client = new FakeGithubCli({
      respond: {
        'repo.view': () =>
          Promise.reject(new GhCliError(['repo', 'view'], 1, 'no git remotes found')),
      },
    });
    const published: Published[] = [];
    const writes = createService(client, published);

    await expect(
      writes.createPullRequest(REQUEST, { chatId: 'chat-1', title: 'T' })
    ).resolves.toEqual({ state: 'no-remote' });
    expect(client.ids()).toEqual(['repo.view']);
    expect(published).toEqual([]);
  });

  it('fails loudly when gh pr create prints something without a pull request URL', async () => {
    const client = new FakeGithubCli({
      stdout: { 'repo.view': repoOutput, 'pr.create': 'Warning: something else entirely' },
    });
    const writes = createService(client);

    await expect(
      writes.createPullRequest(REQUEST, { chatId: 'chat-1', title: 'T' })
    ).rejects.toBeInstanceOf(GithubOutputError);
  });

  /**
   * `gh pr checkout` fetches a ref and switches the working tree, exactly
   * what the git write service's own mutations do — so it has to take the
   * same repository-scoped lock they do, or a concurrent stage, commit, or
   * worktree operation can race it. `pr ready` never touches the working
   * tree, so it must not pay for a lock it does not need.
   */
  it('serializes a checkout through the resolved repository root, not a ready', async () => {
    const client = createClient();
    const lockCalls: Array<{ environmentId: string; scope: string }> = [];
    const writes = createGithubWriteService({
      client,
      cache: createGithubCache(),
      currentBranch: () => Promise.resolve('feat/panel'),
      pullRequestTemplate: () => Promise.resolve(''),
      publish: () => undefined,
      requireRepoRoot: () => Promise.resolve('/remote/repo-root'),
      withMutationLock: (environmentId, scope, mutation) => {
        lockCalls.push({ environmentId, scope });
        return mutation();
      },
    });

    await writes.checkoutPullRequest(REQUEST, { chatId: 'chat-1', number: 7 });
    expect(lockCalls).toEqual([{ environmentId: 'devbox', scope: '/remote/repo-root' }]);

    await writes.markPullRequestReady(REQUEST, { chatId: 'chat-1', number: 7 });
    expect(lockCalls).toEqual([{ environmentId: 'devbox', scope: '/remote/repo-root' }]);
  });
});
