import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import {
  type GitWorktreeListResponse,
  GitWorktreeListResponseSchema,
} from '@mangostudio/shared/git';
import { gitTopic, type RealtimeInvalidateEvent } from '@mangostudio/shared/realtime';
import Value from 'typebox/value';
import { getDb } from '../../../src/db/database';
import { resolveGitCommonDir } from '../../../src/modules/git/domain/git-common-dir';
import { gitRoutes } from '../../../src/modules/git/http/git-routes';
import {
  createRealtimeBus,
  setRealtimeBusForTests,
} from '../../../src/services/realtime/realtime-bus';
import { createTargetPaths } from '../../../src/services/runtime-client/target-paths';
import { insertTestChat, insertTestUser } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const hasGit = Bun.which('git') !== null;
// This suite runs real `git` against the actual filesystem rather than a
// runtime host, so the path semantics `resolveGitCommonDir` needs are this
// process's own platform rather than a stub for one.
const hostPaths = createTargetPaths({
  pathStyle: process.platform === 'win32' ? 'win32' : 'posix',
  homeDir: tmpdir(),
} as Parameters<typeof createTargetPaths>[0]);
const tempDirs: string[] = [];
let restoreAuth: (() => void) | null = null;

type TestApp = ReturnType<typeof createAuthenticatedApiTestApp>['app'];

async function runFixtureGit(cwd: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    },
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

/** A repository with one commit — `worktree add` needs a resolvable HEAD. */
async function createTempRepo(): Promise<{ root: string; parent: string }> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'mango-git-worktrees-')));
  tempDirs.push(parent);
  const root = join(parent, 'main');
  await runFixtureGit(parent, ['init', 'main']);
  await runFixtureGit(root, ['config', 'user.email', 'worktrees@mangostudio.test']);
  await runFixtureGit(root, ['config', 'user.name', 'Worktree Test']);
  await runFixtureGit(root, ['config', 'commit.gpgSign', 'false']);
  // Developer machines may set core.hooksPath globally; point at this repo's own
  // hooks directory so a global hook cannot fail the fixture.
  await runFixtureGit(root, ['config', 'core.hooksPath', join(root, '.git', 'hooks')]);
  await writeFile(join(root, 'tracked.txt'), 'initial\n');
  await runFixtureGit(root, ['add', 'tracked.txt']);
  await runFixtureGit(root, ['commit', '-m', 'initial']);
  return { root, parent };
}

async function createChatFixture(workdir: string) {
  const user = await insertTestUser();
  const chat = await insertTestChat(user.id);
  await getDb().updateTable('chats').set({ workdir }).where('id', '=', chat.id).execute();
  const authenticated = createAuthenticatedApiTestApp(user, gitRoutes);
  restoreAuth = authenticated.restore;
  return { app: authenticated.app, chatId: chat.id, user };
}

/** A second chat for the same user, pointed at another directory of the same repository. */
async function addChat(userId: string, workdir: string): Promise<string> {
  const chat = await insertTestChat(userId);
  await getDb().updateTable('chats').set({ workdir }).where('id', '=', chat.id).execute();
  return chat.id;
}

function sendJson(app: TestApp, method: 'POST' | 'DELETE', body: unknown) {
  return app.handle(
    new Request('http://localhost/git/worktrees', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

function listWorktrees(app: TestApp, chatId: string) {
  const url = new URL('http://localhost/git/worktrees');
  url.searchParams.set('chatId', chatId);
  return app.handle(new Request(url.toString()));
}

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  setRealtimeBusForTests(undefined);
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Git worktree routes', () => {
  it.skipIf(!hasGit)('lists the main worktree first, then the linked ones', async () => {
    const { root, parent } = await createTempRepo();
    const linked = join(parent, 'feature');
    await runFixtureGit(root, ['worktree', 'add', '-b', 'feat/panel', linked]);
    const { app, chatId } = await createChatFixture(root);

    const response = await listWorktrees(app, chatId);
    const payload = (await response.json()) as GitWorktreeListResponse;

    expect(response.status).toBe(200);
    expect(Value.Check(GitWorktreeListResponseSchema, payload)).toBe(true);
    expect(payload.worktrees[0]).toMatchObject({ path: root, isMain: true });
    expect(payload.worktrees[1]).toMatchObject({
      path: linked,
      branch: 'feat/panel',
      isMain: false,
      isDetached: false,
    });
  });

  it.skipIf(!hasGit)('creates a worktree on a new branch and announces it', async () => {
    const { root, parent } = await createTempRepo();
    const { app, chatId, user } = await createChatFixture(root);
    const bus = createRealtimeBus();
    const events: RealtimeInvalidateEvent[] = [];
    bus.subscribe(user.id, (event) => events.push(event));
    setRealtimeBusForTests(bus);
    const target = join(parent, 'feature');

    const response = await sendJson(app, 'POST', {
      chatId,
      path: target,
      mode: 'new-branch',
      branch: 'feat/panel',
    });
    const payload = (await response.json()) as GitWorktreeListResponse;

    expect(response.status).toBe(200);
    expect(Value.Check(GitWorktreeListResponseSchema, payload)).toBe(true);
    expect(payload.worktrees.map((worktree) => worktree.path)).toEqual([root, target]);
    expect(await runFixtureGit(target, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feat/panel');
    // The bus also carries environment events; only the git topic is this route's.
    expect(events.filter((event) => event.topic === gitTopic(chatId))).toEqual([
      { type: 'invalidate', topic: gitTopic(chatId), scopes: ['branches'] },
    ]);
  });

  it.skipIf(!hasGit)('checks an existing branch out into a new worktree', async () => {
    const { root, parent } = await createTempRepo();
    await runFixtureGit(root, ['branch', 'feat/existing']);
    const { app, chatId } = await createChatFixture(root);
    const target = join(parent, 'existing');

    const response = await sendJson(app, 'POST', {
      chatId,
      path: target,
      mode: 'existing-branch',
      branch: 'feat/existing',
    });
    const payload = (await response.json()) as GitWorktreeListResponse;

    expect(response.status).toBe(200);
    expect(payload.worktrees[1]).toMatchObject({ path: target, branch: 'feat/existing' });
  });

  it.skipIf(!hasGit)('refuses a path or branch Git would read as an option', async () => {
    const { root } = await createTempRepo();
    const { app, chatId } = await createChatFixture(root);

    const dashedPath = await sendJson(app, 'POST', {
      chatId,
      path: '--force',
      mode: 'new-branch',
      branch: 'feat/panel',
    });
    const dashedBranch = await sendJson(app, 'POST', {
      chatId,
      path: '/tmp/mango-never-created',
      mode: 'new-branch',
      branch: '--detach',
    });

    expect(dashedPath.status).toBe(422);
    expect(await dashedPath.json()).toMatchObject({ code: ERROR_CODES.VALIDATION });
    expect(dashedBranch.status).toBe(422);
  });

  it.skipIf(!hasGit)('refuses a path another worktree already occupies', async () => {
    const { root, parent } = await createTempRepo();
    const target = join(parent, 'feature');
    await runFixtureGit(root, ['worktree', 'add', '-b', 'feat/panel', target]);
    const { app, chatId } = await createChatFixture(root);

    const response = await sendJson(app, 'POST', {
      chatId,
      path: target,
      mode: 'new-branch',
      branch: 'feat/other',
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: ERROR_CODES.CONFLICT });
  });

  it.skipIf(!hasGit)('removes a linked worktree and returns the remaining list', async () => {
    const { root, parent } = await createTempRepo();
    const target = join(parent, 'feature');
    await runFixtureGit(root, ['worktree', 'add', '-b', 'feat/panel', target]);
    const { app, chatId } = await createChatFixture(root);

    const response = await sendJson(app, 'DELETE', { chatId, path: target });
    const payload = (await response.json()) as GitWorktreeListResponse;

    expect(response.status).toBe(200);
    expect(payload.worktrees.map((worktree) => worktree.path)).toEqual([root]);
  });

  it.skipIf(!hasGit)('refuses to remove the main worktree', async () => {
    const { root } = await createTempRepo();
    const { app, chatId } = await createChatFixture(root);

    const response = await sendJson(app, 'DELETE', { chatId, path: root });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: ERROR_CODES.CONFLICT });
  });

  it.skipIf(!hasGit)('refuses to remove the worktree the calling chat lives in', async () => {
    const { root, parent } = await createTempRepo();
    const target = join(parent, 'feature');
    await runFixtureGit(root, ['worktree', 'add', '-b', 'feat/panel', target]);
    // The chat is bound to the linked worktree, so removing it would delete the
    // directory every later request in this panel resolves against.
    const { app, chatId } = await createChatFixture(target);

    const response = await sendJson(app, 'DELETE', { chatId, path: target });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: ERROR_CODES.CONFLICT });
  });

  it.skipIf(!hasGit)('refuses to remove a locked worktree and surfaces the reason', async () => {
    const { root, parent } = await createTempRepo();
    const target = join(parent, 'feature');
    await runFixtureGit(root, ['worktree', 'add', '-b', 'feat/panel', target]);
    await runFixtureGit(root, ['worktree', 'lock', '--reason', 'held for review', target]);
    const { app, chatId } = await createChatFixture(root);

    const response = await sendJson(app, 'DELETE', { chatId, path: target, force: true });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: ERROR_CODES.CONFLICT,
      details: { stderr: 'held for review' },
    });
  });

  it.skipIf(!hasGit)('keeps uncommitted work until the caller forces the removal', async () => {
    const { root, parent } = await createTempRepo();
    const target = join(parent, 'feature');
    await runFixtureGit(root, ['worktree', 'add', '-b', 'feat/panel', target]);
    await writeFile(join(target, 'tracked.txt'), 'local edit\n');
    const { app, chatId } = await createChatFixture(root);

    const refused = await sendJson(app, 'DELETE', { chatId, path: target });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: ERROR_CODES.CONFLICT });

    const forced = await sendJson(app, 'DELETE', { chatId, path: target, force: true });
    const payload = (await forced.json()) as GitWorktreeListResponse;
    expect(forced.status).toBe(200);
    expect(payload.worktrees.map((worktree) => worktree.path)).toEqual([root]);
  });

  it.skipIf(!hasGit)('answers 404 for a path no worktree occupies', async () => {
    const { root, parent } = await createTempRepo();
    const { app, chatId } = await createChatFixture(root);

    const response = await sendJson(app, 'DELETE', { chatId, path: join(parent, 'absent') });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: ERROR_CODES.NOT_FOUND });
  });

  it.skipIf(!hasGit)(
    'derives one mutation-lock key from the main worktree and from a linked one',
    async () => {
      const { root, parent } = await createTempRepo();
      const linked = join(parent, 'feature');
      await runFixtureGit(root, ['worktree', 'add', '-b', 'feat/panel', linked]);

      // Git answers `--git-common-dir` relative to its own working directory, so
      // the main worktree prints `.git` and the linked one prints an absolute
      // path. Unresolved, those are two keys for one repository — and the two
      // `worktree add` calls that share a registry would not serialize.
      const fromMain = await runFixtureGit(root, ['rev-parse', '--git-common-dir']);
      const fromLinked = await runFixtureGit(linked, ['rev-parse', '--git-common-dir']);
      expect(fromMain).not.toBe(fromLinked);

      expect(resolveGitCommonDir(root, fromMain, hostPaths)).toBe(join(root, '.git'));
      expect(resolveGitCommonDir(linked, fromLinked, hostPaths)).toBe(
        resolveGitCommonDir(root, fromMain, hostPaths)
      );
    }
  );

  it.skipIf(!hasGit)(
    'serializes concurrent adds issued from the main and a linked worktree',
    async () => {
      const { root, parent } = await createTempRepo();
      const linked = join(parent, 'feature');
      await runFixtureGit(root, ['worktree', 'add', '-b', 'feat/panel', linked]);
      const { app, chatId, user } = await createChatFixture(root);
      const linkedChatId = await addChat(user.id, linked);

      const [fromMain, fromLinked] = await Promise.all([
        sendJson(app, 'POST', {
          chatId,
          path: join(parent, 'from-main'),
          mode: 'new-branch',
          branch: 'feat/from-main',
        }),
        sendJson(app, 'POST', {
          chatId: linkedChatId,
          path: join(parent, 'from-linked'),
          mode: 'new-branch',
          branch: 'feat/from-linked',
        }),
      ]);

      expect(fromMain.status).toBe(200);
      expect(fromLinked.status).toBe(200);
      // Both registrations survive: the second add read a registry the first had
      // finished writing rather than one it was halfway through.
      const listed = (await (await listWorktrees(app, chatId)).json()) as GitWorktreeListResponse;
      expect(listed.worktrees.map((worktree) => worktree.path).sort()).toEqual(
        [root, linked, join(parent, 'from-main'), join(parent, 'from-linked')].sort()
      );
    }
  );
});
