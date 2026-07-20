import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type GithubContext, GithubContextSchema } from '@mangostudio/shared/github';
import { Value } from '@sinclair/typebox/value';
import { getDb } from '../../../src/db/database';
import { createGithubContextService } from '../../../src/modules/github/application/github-context-service';
import { createGithubRoutes } from '../../../src/modules/github/http/github-routes';
import { createGhCli } from '../../../src/modules/github/infrastructure/gh-cli';
import { insertTestChat, insertTestUser } from '../../support/factories';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';

interface ShimScenario {
  readonly authenticated?: boolean;
  readonly repoStdout?: string;
  readonly repoStderr?: string;
  readonly prStdout?: string;
  readonly prStderr?: string;
}

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

const tempDirs: string[] = [];
let restoreAuth: (() => void) | null = null;

async function createTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'mango-github-routes-'));
  tempDirs.push(path);
  return path;
}

function shellResult(stdout: string | undefined, stderr: string | undefined): string {
  if (stderr !== undefined) return `printf '%s\\n' '${stderr}' >&2\nexit 1`;
  return `printf '%s\\n' '${stdout ?? ''}'\nexit 0`;
}

async function createGithubPlugin(workdir: string, scenario?: ShimScenario) {
  const binDir = await createTempDir();
  if (scenario) {
    const script = `#!/bin/sh
case "$*" in
  "--version")
    printf '%s\\n' 'gh version 2.96.0'
    exit 0
    ;;
  "auth status")
    ${scenario.authenticated === false ? "printf '%s\\n' 'not logged in' >&2\n    exit 1" : 'exit 0'}
    ;;
  "repo view --json nameWithOwner,defaultBranchRef,url")
    ${shellResult(scenario.repoStdout ?? repoOutput, scenario.repoStderr)}
    ;;
  "pr view --json number,title,state,isDraft,url,headRefName,baseRefName")
    ${shellResult(scenario.prStdout ?? prOutput, scenario.prStderr)}
    ;;
  *)
    printf '%s\\n' 'unexpected gh command' >&2
    exit 64
    ;;
esac
`;
    const shimPath = join(binDir, 'gh');
    await writeFile(shimPath, script);
    await chmod(shimPath, 0o755);
  }

  const cli = createGhCli({
    environment: {
      PATH: binDir,
      HOME: workdir,
    },
  });
  return createGithubRoutes(createGithubContextService(cli));
}

async function bindWorkdir(chatId: string, workdir: string): Promise<void> {
  await getDb().updateTable('chats').set({ workdir }).where('id', '=', chatId).execute();
}

function getContext(app: ReturnType<typeof createAuthenticatedApiTestApp>['app'], chatId: string) {
  const url = new URL('http://localhost/github/context');
  url.searchParams.set('chatId', chatId);
  return app.handle(new Request(url.toString()));
}

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('GitHub context routes', () => {
  it('returns schema-valid repository and pull request context from a fake gh', async () => {
    const workdir = await createTempDir();
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    await bindWorkdir(chat.id, workdir);
    const plugin = await createGithubPlugin(workdir, {});
    const { app, restore } = createAuthenticatedApiTestApp(user, plugin);
    restoreAuth = restore;

    const response = await getContext(app, chat.id);
    const payload = (await response.json()) as GithubContext;

    expect(response.status).toBe(200);
    expect(Value.Check(GithubContextSchema, payload)).toBe(true);
    expect(payload).toEqual({
      state: 'ok',
      repo: {
        nameWithOwner: 'mango/mangostudio',
        defaultBranch: 'main',
        url: 'https://github.example/mango/mangostudio',
      },
      pr: JSON.parse(prOutput),
    });
  });

  it('treats a branch without a pull request as successful repository context', async () => {
    const workdir = await createTempDir();
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    await bindWorkdir(chat.id, workdir);
    const plugin = await createGithubPlugin(workdir, {
      prStderr: 'no pull requests found for branch "feat/no-pr"',
    });
    const { app, restore } = createAuthenticatedApiTestApp(user, plugin);
    restoreAuth = restore;

    const response = await getContext(app, chat.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: 'ok', pr: null });
  });

  it('degrades cleanly when PATH contains no gh executable', async () => {
    const workdir = await createTempDir();
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    await bindWorkdir(chat.id, workdir);
    const plugin = await createGithubPlugin(workdir);
    const { app, restore } = createAuthenticatedApiTestApp(user, plugin);
    restoreAuth = restore;

    const response = await getContext(app, chat.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'gh-not-installed' });
  });

  it('maps authentication and remote discovery failures without leaking stderr', async () => {
    const cases: ReadonlyArray<{
      scenario: ShimScenario;
      expected: GithubContext['state'];
    }> = [
      { scenario: { authenticated: false }, expected: 'not-authenticated' },
      { scenario: { repoStderr: 'no git remotes found' }, expected: 'no-remote' },
      {
        scenario: {
          repoStderr:
            'none of the git remotes configured for this repository point to a known GitHub host',
        },
        expected: 'not-a-github-remote',
      },
    ];

    for (const { scenario, expected } of cases) {
      const workdir = await createTempDir();
      const user = await insertTestUser();
      const chat = await insertTestChat(user.id);
      await bindWorkdir(chat.id, workdir);
      const plugin = await createGithubPlugin(workdir, scenario);
      const { app, restore } = createAuthenticatedApiTestApp(user, plugin);
      restoreAuth = restore;

      try {
        const response = await getContext(app, chat.id);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ state: expected });
      } finally {
        restore();
        restoreAuth = null;
      }
    }
  });

  it('enforces authentication, ownership, and a bound working directory', async () => {
    const workdir = await createTempDir();
    const plugin = await createGithubPlugin(workdir, {});
    const unauthenticatedApp = createApiTestApp(plugin);
    const unauthenticated = await unauthenticatedApp.handle(
      new Request('http://localhost/github/context?chatId=chat-1')
    );
    expect(unauthenticated.status).toBe(401);

    const [requestingUser, owner] = await Promise.all([insertTestUser(), insertTestUser()]);
    const foreignChat = await insertTestChat(owner.id);
    const ownChat = await insertTestChat(requestingUser.id);
    const { app, restore } = createAuthenticatedApiTestApp(requestingUser, plugin);
    restoreAuth = restore;

    const forbidden = await getContext(app, foreignChat.id);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      error: 'Chat belongs to another user',
      code: 'OWNERSHIP',
    });

    const noWorkdir = await getContext(app, ownChat.id);
    expect(noWorkdir.status).toBe(409);
    expect(await noWorkdir.json()).toEqual({
      error: 'Chat has no working directory',
      code: 'CONFLICT',
    });

    const missing = await getContext(app, 'chat-does-not-exist');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Chat not found', code: 'NOT_FOUND' });
  });

  it('returns a typed API error when gh emits invalid JSON', async () => {
    const workdir = await createTempDir();
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    await bindWorkdir(chat.id, workdir);
    const plugin = await createGithubPlugin(workdir, { repoStdout: '{not-json' });
    const { app, restore } = createAuthenticatedApiTestApp(user, plugin);
    restoreAuth = restore;

    const response = await getContext(app, chat.id);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'GitHub context could not be read',
      code: 'GH_OUTPUT_INVALID',
    });
  });
});
