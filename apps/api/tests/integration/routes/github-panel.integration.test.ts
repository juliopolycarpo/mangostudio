import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  GithubCreatePrResponseSchema,
  GithubInboxResponseSchema,
  GithubIssuesResponseSchema,
  GithubPrActionResponseSchema,
  GithubPrChecksResponseSchema,
  GithubPrDetailResponseSchema,
  GithubPrsResponseSchema,
  GithubPrThreadsResponseSchema,
  type GithubUnavailableState,
} from '@mangostudio/shared/github';
import type { TSchema } from 'typebox';
import Value from 'typebox/value';
import { getDb } from '../../../src/db/database';
import { createGithubCache } from '../../../src/modules/github/application/github-cache';
import { createGithubReadService } from '../../../src/modules/github/application/github-read-service';
import { createGithubWriteService } from '../../../src/modules/github/application/github-write-service';
import { createGithubRoutes } from '../../../src/modules/github/http/github-routes';
import { GhCliError } from '../../../src/modules/github/infrastructure/gh-cli';
import { insertTestChat, insertTestUser } from '../../support/factories';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';
import { FakeGithubCli, type FakeGithubCliOptions } from '../../support/mocks/fake-github-cli';

const REPO_OUTPUT = JSON.stringify({
  nameWithOwner: 'mango/mangostudio',
  defaultBranchRef: { name: 'main' },
  url: 'https://github.example/mango/mangostudio',
});

const PR_SUMMARY = {
  number: 7,
  title: 'Add the panel',
  url: 'https://github.example/mango/mangostudio/pull/7',
  state: 'OPEN',
  isDraft: false,
  headRefName: 'feat/panel',
  baseRefName: 'main',
  updatedAt: '2026-08-20T10:00:00Z',
  author: { id: 'x', is_bot: false, login: 'octocat', name: 'Mona' },
  labels: [{ id: 'l', name: 'area:api', description: '', color: 'c5def5' }],
  reviewDecision: '',
  statusCheckRollup: [
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'StatusContext', context: 'coderabbit', state: 'PENDING' },
  ],
};

const DEFAULT_STDOUT = {
  'repo.view': REPO_OUTPUT,
  'pr.list': JSON.stringify([PR_SUMMARY]),
  'pr.view-summary': JSON.stringify(PR_SUMMARY),
  'pr.create': 'https://github.example/mango/mangostudio/pull/7\n',
  'pr.ready': '',
  'pr.checkout': '',
  'issue.list': JSON.stringify([
    {
      number: 3,
      title: 'Broken',
      url: 'https://github.example/mango/mangostudio/issues/3',
      state: 'OPEN',
      updatedAt: '2026-08-20T10:00:00Z',
      author: { id: 'x', is_bot: false, login: 'octocat' },
      labels: [],
      assignees: [],
    },
  ]),
  'pr.view': JSON.stringify({
    number: 7,
    title: 'Add the panel',
    body: 'why',
    url: 'https://github.example/mango/mangostudio/pull/7',
    isDraft: true,
    reviewDecision: '',
    mergeStateStatus: 'CLEAN',
    mergeable: 'MERGEABLE',
    changedFiles: 3,
    additions: 10,
    deletions: 2,
    latestReviews: [],
    labels: [],
  }),
  'pr.checks': JSON.stringify([
    {
      name: 'build',
      bucket: 'pass',
      state: 'SUCCESS',
      link: 'https://ci.example/1',
      workflow: 'CI',
      description: '',
      startedAt: '2026-08-20T10:00:00Z',
      completedAt: '0001-01-01T00:00:00Z',
    },
  ]),
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
                path: 'apps/api/src/x.ts',
                line: null,
                comments: { totalCount: 1, nodes: [{ author: null, body: 'gone' }] },
              },
            ],
          },
        },
      },
    },
  }),
  'search.prs': JSON.stringify([
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
  ]),
} as const;

let restoreAuth: (() => void) | null = null;

/**
 * Mounts the panel routes over a `gh` that answers from a table.
 *
 * The old shell-script shim on PATH no longer intercepts anything — the spawn
 * happens on the runtime now — so the facade itself is the seam.
 */
function createPanelPlugin(overrides: FakeGithubCliOptions = {}) {
  const client = new FakeGithubCli({
    ...overrides,
    stdout: { ...DEFAULT_STDOUT, ...overrides.stdout },
  });
  const cache = createGithubCache();
  return {
    client,
    plugin: createGithubRoutes({
      reads: createGithubReadService({
        client,
        cache,
        now: () => 1_000,
        homeCwd: () => Promise.resolve('/remote/home'),
      }),
      writes: createGithubWriteService({
        client,
        cache,
        currentBranch: () => Promise.resolve('feat/panel'),
        pullRequestTemplate: () => Promise.resolve('## Summary'),
        publish: () => undefined,
        // `pr checkout` resolves the repository root through the real git
        // write service to take its mutation lock, which would otherwise
        // spawn a real `git rev-parse` against `/remote/repo` — a workdir this
        // route-shape test never backs with an actual checkout. The lock
        // itself is `git-write-service.test.ts`'s job, not this file's.
        requireRepoRoot: () => Promise.resolve('/remote/repo'),
        withMutationLock: (_environmentId, _scope, mutation) => mutation(),
      }),
    }),
  };
}

async function createChatWithWorkdir() {
  const user = await insertTestUser();
  const chat = await insertTestChat(user.id);
  await getDb()
    .updateTable('chats')
    .set({ workdir: '/remote/repo' })
    .where('id', '=', chat.id)
    .execute();
  return { user, chat };
}

function get(
  app: ReturnType<typeof createAuthenticatedApiTestApp>['app'],
  path: string,
  params: Record<string, string>
) {
  const url = new URL(`http://localhost${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return app.handle(new Request(url.toString()));
}

function post(
  app: ReturnType<typeof createAuthenticatedApiTestApp>['app'],
  path: string,
  body: unknown
) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

async function expectSchemaValid(response: Response, schema: TSchema): Promise<unknown> {
  const payload = await response.json();
  expect(response.status).toBe(200);
  expect(Value.Check(schema, payload)).toBe(true);
  return payload;
}

afterEach(() => {
  restoreAuth?.();
  restoreAuth = null;
});

describe('GitHub panel reads', () => {
  it('serves schema-valid pull requests, with the rollup reduced to counters', async () => {
    const { user, chat } = await createChatWithWorkdir();
    const { plugin } = createPanelPlugin();
    const { app, restore } = createAuthenticatedApiTestApp(user, plugin);
    restoreAuth = restore;

    const response = await get(app, '/github/prs', { chatId: chat.id, filter: 'open' });
    const payload = await expectSchemaValid(response, GithubPrsResponseSchema);

    expect(payload).toEqual({
      state: 'ok',
      cachedAt: 1_000,
      repo: {
        nameWithOwner: 'mango/mangostudio',
        defaultBranch: 'main',
        url: 'https://github.example/mango/mangostudio',
      },
      prs: [
        {
          number: 7,
          title: 'Add the panel',
          url: 'https://github.example/mango/mangostudio/pull/7',
          state: 'OPEN',
          isDraft: false,
          headRefName: 'feat/panel',
          baseRefName: 'main',
          updatedAt: '2026-08-20T10:00:00Z',
          author: { login: 'octocat', isBot: false },
          labels: [{ name: 'area:api', color: 'c5def5' }],
          reviewDecision: null,
          checks: { passed: 1, failed: 0, pending: 1, total: 2 },
        },
      ],
    });
    // The full per-check array must never reach the client.
    expect(JSON.stringify(payload)).not.toContain('__typename');
  });

  it('serves schema-valid issues', async () => {
    const { user, chat } = await createChatWithWorkdir();
    const { plugin } = createPanelPlugin();
    const { app, restore } = createAuthenticatedApiTestApp(user, plugin);
    restoreAuth = restore;

    const payload = await expectSchemaValid(
      await get(app, '/github/issues', { chatId: chat.id, filter: 'assigned' }),
      GithubIssuesResponseSchema
    );
    expect(payload).toMatchObject({ state: 'ok', issues: [{ number: 3, state: 'OPEN' }] });
  });

  it('serves the pull request detail, its checks and its review threads', async () => {
    const { user, chat } = await createChatWithWorkdir();
    const { plugin, client } = createPanelPlugin();
    const { app, restore } = createAuthenticatedApiTestApp(user, plugin);
    restoreAuth = restore;

    const detail = await expectSchemaValid(
      await get(app, '/github/pr', { chatId: chat.id, number: '7' }),
      GithubPrDetailResponseSchema
    );
    expect(detail).toMatchObject({
      state: 'ok',
      // `isDraft` travels in its own right: the fixture is a draft whose merge
      // state is `CLEAN`, which is the pairing GitHub actually returns and the
      // one that used to hide "mark ready for review".
      pr: { number: 7, isDraft: true, reviewDecision: null, mergeStateStatus: 'CLEAN' },
    });

    const checks = await expectSchemaValid(
      await get(app, '/github/pr/checks', { chatId: chat.id, number: '7' }),
      GithubPrChecksResponseSchema
    );
    expect(checks).toMatchObject({
      state: 'ok',
      summary: { passed: 1, failed: 0, pending: 0, total: 1 },
      checks: [{ name: 'build', startedAt: '2026-08-20T10:00:00Z' }],
    });
    // gh's year-1 "never finished" timestamp is dropped, not shipped as a date.
    expect(JSON.stringify(checks)).not.toContain('0001-01-01');

    const threads = await expectSchemaValid(
      await get(app, '/github/pr/review-threads', { chatId: chat.id, number: '7' }),
      GithubPrThreadsResponseSchema
    );
    expect(threads).toMatchObject({
      state: 'ok',
      threads: [{ isOutdated: true, line: null, comments: [{ author: null, body: 'gone' }] }],
    });
    expect(client.calls.at(-1)?.params).toEqual({
      owner: 'mango',
      name: 'mangostudio',
      number: 7,
    });
  });

  it('serves the inbox without a chat, a workdir or a remote', async () => {
    // The one read that is not chat-scoped: "waiting on you" spans every
    // repository the account can see, so there is no workdir that would pick
    // one. It runs in the runtime's own home directory.
    const user = await insertTestUser();
    const { plugin, client } = createPanelPlugin();
    const { app, restore } = createAuthenticatedApiTestApp(user, plugin);
    restoreAuth = restore;

    const payload = await expectSchemaValid(
      await get(app, '/github/inbox', {}),
      GithubInboxResponseSchema
    );

    expect(payload).toEqual({
      state: 'ok',
      cachedAt: 1_000,
      items: [
        {
          number: 12,
          title: 'Review me',
          url: 'https://github.example/other/repo/pull/12',
          // Upper-cased: `gh search prs` spells state lowercase while every
          // other command spells it uppercase.
          state: 'OPEN',
          isDraft: false,
          updatedAt: '2026-08-20T10:00:00Z',
          author: { login: 'octocat', isBot: false },
          labels: [],
          repository: { nameWithOwner: 'other/repo' },
        },
      ],
    });
    expect(client.ids()).toEqual(['search.prs']);
    expect(client.calls[0]?.cwd).toBe('/remote/home');
  });

  it('reports every non-ok state as a 200 carrying that state', async () => {
    const cases: ReadonlyArray<{
      options: FakeGithubCliOptions;
      expected: GithubUnavailableState['state'];
    }> = [
      { options: { available: false }, expected: 'gh-not-installed' },
      { options: { authenticated: false }, expected: 'not-authenticated' },
      {
        options: {
          respond: {
            'repo.view': () =>
              Promise.reject(new GhCliError(['repo', 'view'], 1, 'no git remotes found')),
          },
        },
        expected: 'no-remote',
      },
      {
        options: {
          respond: {
            'repo.view': () =>
              Promise.reject(
                new GhCliError(
                  ['repo', 'view'],
                  1,
                  'none of the git remotes configured for this repository point to a known GitHub host'
                )
              ),
          },
        },
        expected: 'not-a-github-remote',
      },
    ];

    for (const { options, expected } of cases) {
      const { user, chat } = await createChatWithWorkdir();
      const { plugin } = createPanelPlugin(options);
      const { app, restore } = createAuthenticatedApiTestApp(user, plugin);
      try {
        const response = await get(app, '/github/prs', { chatId: chat.id });
        expect(response.status).toBe(200);
        // The whole body, so a regression that appends gh's stderr to an
        // otherwise-correct state fails here rather than passing a partial match.
        expect(await response.json()).toEqual({ state: expected });
      } finally {
        restore();
      }
    }
  });

  it('never lets gh stderr reach a response body', async () => {
    const secret = 'fatal: could not read Password for https://token@github.com';
    const { user, chat } = await createChatWithWorkdir();
    const { plugin } = createPanelPlugin({
      respond: { 'pr.list': () => Promise.reject(new GhCliError(['pr', 'list'], 1, secret)) },
    });
    const { app, restore } = createAuthenticatedApiTestApp(user, plugin);
    restoreAuth = restore;

    const response = await get(app, '/github/prs', { chatId: chat.id });

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain(secret);
    expect(body).not.toContain('token@github.com');
    expect(JSON.parse(body)).toEqual({
      error: 'GitHub context could not be read',
      code: 'INTERNAL',
    });
  });

  it('never writes gh pr create prose to the server log', async () => {
    // `error.args` on a failed `gh pr create` carries the full `--title`/`--body`
    // argv, and `--body` is often the repository's own pull-request template —
    // prose meant for GitHub, not the server's own log file.
    const title = 'Fix the leak';
    const body = 'Confidential rollout notes nobody outside GitHub should see.';
    const { user, chat } = await createChatWithWorkdir();
    const { plugin } = createPanelPlugin({
      respond: {
        'pr.create': () =>
          Promise.reject(
            new GhCliError(['pr', 'create', '--title', title, '--body', body], 1, 'fatal: exit 1')
          ),
      },
    });
    const { app, restore } = createAuthenticatedApiTestApp(user, plugin);
    restoreAuth = restore;
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await post(app, '/github/pr', { chatId: chat.id, title, body });
      expect(response.status).toBe(500);

      const logged = errorSpy.mock.calls.map((call) => JSON.stringify(call));
      expect(logged.some((entry) => entry.includes(title))).toBe(false);
      expect(logged.some((entry) => entry.includes(body))).toBe(false);
      expect(logged.some((entry) => entry.includes('"args":["pr","create"]'))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('answers a typed error, not gh output, when gh emits unreadable JSON', async () => {
    const { user, chat } = await createChatWithWorkdir();
    const { plugin } = createPanelPlugin({ stdout: { 'pr.list': '{not-json' } });
    const { app, restore } = createAuthenticatedApiTestApp(user, plugin);
    restoreAuth = restore;

    const response = await get(app, '/github/prs', { chatId: chat.id });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'GitHub context could not be read',
      code: 'GH_OUTPUT_INVALID',
    });
  });
});

describe('GitHub panel writes', () => {
  it('opens a pull request and answers with the row it created', async () => {
    const { user, chat } = await createChatWithWorkdir();
    const { plugin, client } = createPanelPlugin();
    const { app, restore } = createAuthenticatedApiTestApp(user, plugin);
    restoreAuth = restore;

    const response = await post(app, '/github/pr', {
      chatId: chat.id,
      title: 'Add the panel',
      body: 'Because.',
      draft: true,
    });
    const payload = await expectSchemaValid(response, GithubCreatePrResponseSchema);

    expect(payload).toMatchObject({
      state: 'ok',
      repo: { nameWithOwner: 'mango/mangostudio' },
      pr: { number: 7 },
    });
    expect(client.calls[1]?.params).toEqual({
      title: 'Add the panel',
      body: 'Because.',
      head: 'feat/panel',
      draft: true,
    });
  });

  it('marks a pull request ready and checks one out', async () => {
    for (const path of ['/github/pr/ready', '/github/pr/checkout']) {
      const { user, chat } = await createChatWithWorkdir();
      const { plugin } = createPanelPlugin();
      const { app, restore } = createAuthenticatedApiTestApp(user, plugin);
      try {
        const payload = await expectSchemaValid(
          await post(app, path, { chatId: chat.id, number: 7 }),
          GithubPrActionResponseSchema
        );
        expect(payload).toMatchObject({ state: 'ok', pr: { number: 7 } });
      } finally {
        restore();
      }
    }
  });

  it('refreshes the list immediately after a write instead of serving the cached page', async () => {
    const { user, chat } = await createChatWithWorkdir();
    const { plugin, client } = createPanelPlugin();
    const { app, restore } = createAuthenticatedApiTestApp(user, plugin);
    restoreAuth = restore;

    await get(app, '/github/prs', { chatId: chat.id });
    await get(app, '/github/prs', { chatId: chat.id });
    expect(client.ids().filter((id) => id === 'pr.list')).toHaveLength(1);

    await post(app, '/github/pr/ready', { chatId: chat.id, number: 7 });
    await get(app, '/github/prs', { chatId: chat.id });

    expect(client.ids().filter((id) => id === 'pr.list')).toHaveLength(2);
  });

  it('reports a non-ok state from a write rather than failing the request', async () => {
    const { user, chat } = await createChatWithWorkdir();
    const { plugin } = createPanelPlugin({ authenticated: false });
    const { app, restore } = createAuthenticatedApiTestApp(user, plugin);
    restoreAuth = restore;

    const response = await post(app, '/github/pr/ready', { chatId: chat.id, number: 7 });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'not-authenticated' });
  });
});

describe('GitHub panel access control', () => {
  it('enforces authentication on every route', async () => {
    const { plugin } = createPanelPlugin();
    const app = createApiTestApp(plugin);

    for (const path of [
      '/github/inbox',
      '/github/prs?chatId=chat-1',
      '/github/issues?chatId=chat-1',
      '/github/pr?chatId=chat-1&number=7',
      '/github/pr/checks?chatId=chat-1&number=7',
      '/github/pr/review-threads?chatId=chat-1&number=7',
    ]) {
      const response = await app.handle(new Request(`http://localhost${path}`));
      expect(response.status).toBe(401);
    }

    for (const path of ['/github/pr', '/github/pr/ready', '/github/pr/checkout']) {
      const response = await app.handle(
        new Request(`http://localhost${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chatId: 'chat-1', title: 'T', number: 7 }),
        })
      );
      expect(response.status).toBe(401);
    }
  });

  it('rejects another user’s chat, a missing chat and a chat with no workdir', async () => {
    const [requestingUser, owner] = await Promise.all([insertTestUser(), insertTestUser()]);
    const foreignChat = await insertTestChat(owner.id);
    const ownChat = await insertTestChat(requestingUser.id);
    const { plugin } = createPanelPlugin();
    const { app, restore } = createAuthenticatedApiTestApp(requestingUser, plugin);
    restoreAuth = restore;

    const forbidden = await get(app, '/github/prs', { chatId: foreignChat.id });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      error: 'Chat belongs to another user',
      code: 'OWNERSHIP',
    });

    const missing = await get(app, '/github/issues', { chatId: 'chat-does-not-exist' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Chat not found', code: 'NOT_FOUND' });

    const conflict = await post(app, '/github/pr/checkout', { chatId: ownChat.id, number: 7 });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: 'Chat has no working directory',
      code: 'CONFLICT',
    });
  });

  it('refuses a query the contract does not allow', async () => {
    const { user, chat } = await createChatWithWorkdir();
    const { plugin, client } = createPanelPlugin();
    const { app, restore } = createAuthenticatedApiTestApp(user, plugin);
    restoreAuth = restore;

    // A filter is a closed literal union precisely because it selects gh flags.
    const badFilter = await get(app, '/github/prs', { chatId: chat.id, filter: '--author=@evil' });
    expect(badFilter.status).toBe(422);

    const badLimit = await get(app, '/github/prs', { chatId: chat.id, limit: '500' });
    expect(badLimit.status).toBe(422);

    const badNumber = await get(app, '/github/pr', { chatId: chat.id, number: '0' });
    expect(badNumber.status).toBe(422);

    expect(client.ids()).toEqual([]);
  });
});
