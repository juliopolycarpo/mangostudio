import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type GitBatchStateResponse,
  GitBatchStateResponseSchema,
  type GitRepoState,
  GitRepoStateSchema,
} from '@mangostudio/shared/git';
import {
  type RealtimeInvalidateEvent,
  REPO_KEY_MAX_LENGTH,
  repoTopic,
} from '@mangostudio/shared/realtime';
import Value from 'typebox/value';

import { getDb } from '../../../src/db/database';
import { gitWriteScopes } from '../../../src/modules/git/application/git-realtime-service';
import { gitRoutes } from '../../../src/modules/git/http/git-routes';
import {
  createRealtimeBus,
  setRealtimeBusForTests,
} from '../../../src/services/realtime/realtime-bus';
import { insertTestChat, insertTestUser } from '../../support/factories';
import { gitFixtureEnv } from '../../support/git-fixture-env';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const hasGit = Bun.which('git') !== null;
const tempDirs: string[] = [];
let restoreAuth: (() => void) | null = null;

type TestApp = ReturnType<typeof createAuthenticatedApiTestApp>['app'];

async function runFixtureGit(cwd: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    env: gitFixtureEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Fixture git failed (${exitCode}): ${stderr.trim()}`);
  return stdout.trim();
}

/** A repository with one commit on `main` and a bare `origin` it can push to. */
async function createRepoWithRemote(parent: string, name: string): Promise<string> {
  const root = join(parent, name);
  await mkdir(root);
  await runFixtureGit(root, ['init', '--initial-branch=main']);
  await runFixtureGit(root, ['config', 'user.email', 'repo-realtime@mangostudio.test']);
  await runFixtureGit(root, ['config', 'user.name', 'Repo Realtime Test']);
  await runFixtureGit(root, ['config', 'commit.gpgSign', 'false']);
  await runFixtureGit(root, ['config', 'core.hooksPath', join(root, '.git', 'hooks')]);
  await mkdir(join(root, 'packages', 'api'), { recursive: true });
  await writeFile(join(root, 'tracked.txt'), 'initial\n');
  await writeFile(join(root, 'packages', 'api', 'index.ts'), 'export {};\n');
  await runFixtureGit(root, ['add', '.']);
  await runFixtureGit(root, ['commit', '-m', 'initial']);
  const remote = join(parent, `${name}-origin.git`);
  await runFixtureGit(parent, ['init', '--bare', '--initial-branch=main', remote]);
  await runFixtureGit(root, ['remote', 'add', 'origin', remote]);
  await runFixtureGit(root, ['push', '-u', 'origin', 'main']);
  return root;
}

async function addChat(userId: string, workdir: string): Promise<string> {
  const chat = await insertTestChat(userId);
  await getDb().updateTable('chats').set({ workdir }).where('id', '=', chat.id).execute();
  return chat.id;
}

function getState(app: TestApp, chatId: string) {
  const url = new URL('http://localhost/git/state');
  url.searchParams.set('chatId', chatId);
  return app.handle(new Request(url.toString()));
}

function postJson(app: TestApp, path: string, body: unknown) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

async function repoKeyOf(app: TestApp, chatId: string): Promise<string> {
  const response = await getState(app, chatId);
  expect(response.status).toBe(200);
  const state = (await response.json()) as GitRepoState;
  expect(Value.Check(GitRepoStateSchema, state)).toBe(true);
  if (state.state !== 'repo' || state.repoKey === undefined) {
    throw new Error(`(repoKeyOf): expected state: repo with a repoKey | received: ${state.state}`);
  }
  return state.repoKey;
}

/** Waits for the asynchronous repo frame; the per-chat frame is synchronous, this one is not. */
async function waitForEvent(
  events: readonly RealtimeInvalidateEvent[],
  topic: string,
  count = 1
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (events.filter((event) => event.topic === topic).length < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `(waitForEvent): expected ${count} frame(s) on ${topic} | received: ${JSON.stringify(events)}`
      );
    }
    await Bun.sleep(10);
  }
}

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  setRealtimeBusForTests(undefined);
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** One owner with chats in several checkouts of one repository, plus an unrelated repository. */
async function createFixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'mango-repo-realtime-')));
  tempDirs.push(parent);
  const root = await createRepoWithRemote(parent, 'repo');
  const other = await createRepoWithRemote(parent, 'other');
  const linked = join(parent, 'repo-linked');
  await runFixtureGit(root, ['worktree', 'add', '-b', 'feat/linked', linked]);
  const symlinked = join(parent, 'repo-symlink');
  await symlink(root, symlinked);

  const owner = await insertTestUser();
  const authenticated = createAuthenticatedApiTestApp(owner, gitRoutes);
  restoreAuth = authenticated.restore;
  const chats = {
    root: await addChat(owner.id, root),
    subdirectory: await addChat(owner.id, join(root, 'packages', 'api')),
    linkedWorktree: await addChat(owner.id, linked),
    throughSymlink: await addChat(owner.id, symlinked),
    otherRepo: await addChat(owner.id, other),
  };
  return { app: authenticated.app, owner, chats, root };
}

describe('repository key on git state reads', () => {
  it.skipIf(!hasGit)(
    'is one key for every checkout of a repository and another for a different repository',
    async () => {
      const { app, chats } = await createFixture();

      const key = await repoKeyOf(app, chats.root);
      expect(key.length).toBeLessThanOrEqual(REPO_KEY_MAX_LENGTH);
      // Subdirectory, linked worktree and symlinked path are all the same
      // repository: Git resolves the toplevel and the common directory, so no
      // stored workdir string decides it.
      expect(await repoKeyOf(app, chats.subdirectory)).toBe(key);
      expect(await repoKeyOf(app, chats.linkedWorktree)).toBe(key);
      expect(await repoKeyOf(app, chats.throughSymlink)).toBe(key);
      expect(await repoKeyOf(app, chats.otherRepo)).not.toBe(key);
    }
  );

  it.skipIf(!hasGit)('is carried by the batched summaries with the same value', async () => {
    const { app, chats } = await createFixture();
    const stateKey = await repoKeyOf(app, chats.linkedWorktree);

    const response = await postJson(app, '/git/state/batch', {
      chatIds: Object.values(chats),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as GitBatchStateResponse;

    expect(Value.Check(GitBatchStateResponseSchema, body)).toBe(true);
    expect(body.states[chats.root]?.repoKey).toBe(stateKey);
    expect(body.states[chats.subdirectory]?.repoKey).toBe(stateKey);
    expect(body.states[chats.throughSymlink]?.repoKey).toBe(stateKey);
    expect(body.states[chats.otherRepo]?.repoKey).not.toBe(stateKey);
  });
});

describe('repo-wide invalidation on git writes', () => {
  it.skipIf(!hasGit)(
    'publishes a commit on the repo topic to every socket of the owner and nobody else',
    async () => {
      const { app, owner, chats, root } = await createFixture();
      const key = await repoKeyOf(app, chats.linkedWorktree);

      const bus = createRealtimeBus();
      const ownerFirstSocket: RealtimeInvalidateEvent[] = [];
      const ownerSecondSocket: RealtimeInvalidateEvent[] = [];
      const strangerSocket: RealtimeInvalidateEvent[] = [];
      bus.subscribe(owner.id, (event) => ownerFirstSocket.push(event));
      bus.subscribe(owner.id, (event) => ownerSecondSocket.push(event));
      bus.subscribe('someone-else', (event) => strangerSocket.push(event));
      setRealtimeBusForTests(bus);

      await writeFile(join(root, 'tracked.txt'), 'changed\n');
      await postJson(app, '/git/stage', { chatId: chats.root, all: true });
      const commit = await postJson(app, '/git/commit', {
        chatId: chats.root,
        title: 'repo wide commit',
      });
      expect(commit.status).toBe(200);
      await waitForEvent(ownerFirstSocket, repoTopic(key), 2);
      await waitForEvent(ownerSecondSocket, repoTopic(key), 2);

      // `stage` then `commit`: one repo frame each, carrying that write's scopes,
      // next to the per-chat frame the older tabs rely on.
      const repoFrames = ownerFirstSocket.filter((event) => event.topic === repoTopic(key));
      expect(repoFrames.map((event) => event.scopes)).toEqual([
        [...gitWriteScopes.stage],
        [...gitWriteScopes.commit],
      ]);
      expect(ownerSecondSocket.filter((event) => event.topic === repoTopic(key))).toEqual(
        repoFrames
      );
      expect(ownerFirstSocket.filter((event) => event.topic === `git:${chats.root}`)).toHaveLength(
        2
      );
      expect(strangerSocket).toEqual([]);
    }
  );

  it.skipIf(!hasGit)('publishes a push on the repo topic with the push scopes', async () => {
    const { app, owner, chats, root } = await createFixture();
    const key = await repoKeyOf(app, chats.subdirectory);
    const bus = createRealtimeBus();
    const events: RealtimeInvalidateEvent[] = [];
    bus.subscribe(owner.id, (event) => events.push(event));
    setRealtimeBusForTests(bus);

    await writeFile(join(root, 'tracked.txt'), 'ahead\n');
    await runFixtureGit(root, ['commit', '-am', 'ahead of origin']);
    const push = await postJson(app, '/git/push', { chatId: chats.root });
    expect(push.status).toBe(200);
    await waitForEvent(events, repoTopic(key));

    expect(events.find((event) => event.topic === repoTopic(key))).toEqual({
      type: 'invalidate',
      topic: repoTopic(key),
      scopes: [...gitWriteScopes.push],
    });
  });

  it.skipIf(!hasGit)('does not announce a write to a repository it did not touch', async () => {
    const { app, owner, chats, root } = await createFixture();
    const unrelatedKey = await repoKeyOf(app, chats.otherRepo);
    const bus = createRealtimeBus();
    const events: RealtimeInvalidateEvent[] = [];
    bus.subscribe(owner.id, (event) => events.push(event));
    setRealtimeBusForTests(bus);

    await writeFile(join(root, 'tracked.txt'), 'changed\n');
    await postJson(app, '/git/stage', { chatId: chats.root, all: true });
    await waitForEvent(events, `git:${chats.root}`);
    // Give the asynchronous repo frame the time it would need to arrive.
    await Bun.sleep(100);

    expect(events.some((event) => event.topic === repoTopic(unrelatedKey))).toBe(false);
  });
});
