import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { type GithubContext, GithubContextSchema } from '@mangostudio/shared/github';
import Value from 'typebox/value';
import { getDb } from '../../../src/db/database';
import { createGithubContextService } from '../../../src/modules/github/application/github-context-service';
import { createGithubRoutes } from '../../../src/modules/github/http/github-routes';
import { createGhCli } from '../../../src/modules/github/infrastructure/gh-cli';
import {
  closeAllRuntimeConnections,
  setRuntimeConnectionManagerForTests,
} from '../../../src/services/runtime-client/runtime-connection-manager';
import { insertTestChat, insertTestUser } from '../../support/factories';
import { buildFakeGh, installFakeGh } from '../../support/fake-gh/install';
import { DEFAULT_PR_OUTPUT, type FakeGhScenario } from '../../support/fake-gh/program';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';

const tempDirs: string[] = [];
let restoreAuth: (() => void) | null = null;
let originalPath: string | undefined;
let buildDir: string;
let built: string;

async function createTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'mango-github-routes-'));
  tempDirs.push(path);
  return path;
}

/**
 * Installs a fake `gh` where the *runtime* will look for it.
 *
 * The spawn now happens inside the runtime service, which rebuilds its
 * environment from `process.env` — so the shim has to go on the real PATH, not
 * on an option handed to the hub-side facade. And it has to be there *before*
 * the local runtime connects: `inspectGh()` runs once per connection and the
 * connection manager caches the manifest, so a runtime already connected under
 * the original PATH would answer "no gh" for the rest of the process.
 *
 * The fake is an executable, not a script: the runtime resolves `gh` and
 * `gh.exe` only, so a shebang file or a `gh.cmd` is invisible to it on Windows.
 * A scenario that is `unusable` fails every call, which is how the runtime's
 * manifest probe reports "no GitHub CLI here". Deleting `gh` from PATH is not
 * an option: PATH is process-wide, and replacing it wholesale would break every
 * other spawn the in-process runtime makes.
 */
async function installGhShim(scenario: FakeGhScenario): Promise<void> {
  const binDir = await installFakeGh(built, scenario, await createTempDir());

  originalPath ??= process.env.PATH;
  // Prepended, never replaced: the runtime still needs the rest of PATH to find
  // git and a shell while it builds its manifest.
  process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`;
  await closeAllRuntimeConnections();
  setRuntimeConnectionManagerForTests(undefined);
}

async function createGithubPlugin(scenario: FakeGhScenario = { unusable: true }) {
  await installGhShim(scenario);
  return createGithubRoutes({ resolveContext: createGithubContextService(createGhCli()) });
}

async function bindWorkdir(chatId: string, workdir: string): Promise<void> {
  await getDb().updateTable('chats').set({ workdir }).where('id', '=', chatId).execute();
}

function getContext(app: ReturnType<typeof createAuthenticatedApiTestApp>['app'], chatId: string) {
  const url = new URL('http://localhost/github/context');
  url.searchParams.set('chatId', chatId);
  return app.handle(new Request(url.toString()));
}

beforeAll(async () => {
  buildDir = await mkdtemp(join(tmpdir(), 'mango-github-fake-gh-'));
  // One build writes an executable the size of Bun, which Windows also scans on first write.
  built = await buildFakeGh(buildDir);
}, 60_000);

afterAll(async () => {
  await rm(buildDir, { recursive: true, force: true });
});

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  // Both halves matter: the PATH so no later file inherits the shim, and the
  // manager so the next connection re-probes against the restored PATH.
  if (originalPath !== undefined) process.env.PATH = originalPath;
  originalPath = undefined;
  await closeAllRuntimeConnections();
  setRuntimeConnectionManagerForTests(undefined);
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('GitHub context routes', () => {
  it('returns schema-valid repository and pull request context from a fake gh', async () => {
    const workdir = await createTempDir();
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    await bindWorkdir(chat.id, workdir);
    const plugin = await createGithubPlugin({});
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
      pr: JSON.parse(DEFAULT_PR_OUTPUT),
    });
  });

  it('treats a branch without a pull request as successful repository context', async () => {
    const workdir = await createTempDir();
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    await bindWorkdir(chat.id, workdir);
    const plugin = await createGithubPlugin({
      prStderr: 'no pull requests found for branch "feat/no-pr"',
    });
    const { app, restore } = createAuthenticatedApiTestApp(user, plugin);
    restoreAuth = restore;

    const response = await getContext(app, chat.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: 'ok', pr: null });
  });

  it('degrades cleanly when the runtime manifest reports no usable gh', async () => {
    const workdir = await createTempDir();
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    await bindWorkdir(chat.id, workdir);
    const plugin = await createGithubPlugin();
    const { app, restore } = createAuthenticatedApiTestApp(user, plugin);
    restoreAuth = restore;

    const response = await getContext(app, chat.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: 'gh-not-installed' });
  });

  it('maps authentication and remote discovery failures without leaking stderr', async () => {
    const cases: ReadonlyArray<{
      scenario: FakeGhScenario;
      expected: GithubContext['state'];
    }> = [
      { scenario: { authenticated: false }, expected: 'not-authenticated' },
      { scenario: { repoStderr: 'no git remotes found' }, expected: 'no-remote' },
      // The ordinary case, not an exotic one: a chat binds to whatever folder
      // the user picked, and most folders are not checkouts at all. This used
      // to fall through the ladder and answer 500.
      {
        scenario: {
          repoStderr:
            'failed to run git: fatal: not a git repository (or any of the parent directories): .git',
        },
        expected: 'no-remote',
      },
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
      const plugin = await createGithubPlugin(scenario);
      const { app, restore } = createAuthenticatedApiTestApp(user, plugin);
      restoreAuth = restore;

      try {
        const response = await getContext(app, chat.id);
        expect(response.status).toBe(200);
        const payload = await response.json();
        // The whole body, so a regression that appends gh's stderr to an
        // otherwise-correct state fails here rather than passing on a
        // `toMatchObject`.
        expect(payload).toEqual({ state: expected });
      } finally {
        restore();
        restoreAuth = null;
      }
    }
  });

  it('enforces authentication, ownership, and a bound working directory', async () => {
    const plugin = await createGithubPlugin({});
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
    const plugin = await createGithubPlugin({ repoStdout: '{not-json' });
    const { app, restore } = createAuthenticatedApiTestApp(user, plugin);
    restoreAuth = restore;

    const response = await getContext(app, chat.id);
    expect(response.status).toBe(500);
    // gh's own output never reaches the body: the route answers with a fixed
    // message and a code, and logs the detail server-side.
    expect(await response.json()).toEqual({
      error: 'GitHub context could not be read',
      code: 'GH_OUTPUT_INVALID',
    });
  });
});
