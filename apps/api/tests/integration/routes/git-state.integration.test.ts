import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type GitRepoState,
  GitRepoStateSchema,
  InitRepoResponseSchema,
} from '@mangostudio/shared/git';
import { Value } from '@sinclair/typebox/value';
import { getDb } from '../../../src/db/database';
import { gitRoutes } from '../../../src/modules/git/http/git-routes';
import { insertTestChat, insertTestUser } from '../../support/factories';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';

const hasGit = Bun.which('git') !== null;
const tempDirs: string[] = [];
let restoreAuth: (() => void) | null = null;

async function createTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'mango-git-routes-'));
  tempDirs.push(path);
  // `git rev-parse --show-toplevel` resolves symlinks, and the system temp dir
  // is one on macOS, so compare against the real path the routes will report.
  return realpath(path);
}

async function bindWorkdir(chatId: string, workdir: string): Promise<void> {
  await getDb().updateTable('chats').set({ workdir }).where('id', '=', chatId).execute();
}

async function runFixtureGit(cwd: string, args: readonly string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`Fixture git failed (${exitCode}): ${stderr.trim()}`);
}

function getState(app: ReturnType<typeof createAuthenticatedApiTestApp>['app'], chatId: string) {
  const url = new URL('http://localhost/git/state');
  url.searchParams.set('chatId', chatId);
  return app.handle(new Request(url.toString()));
}

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('git routes', () => {
  it.skipIf(!hasGit)('moves from not-a-repo through init to a clean repository', async () => {
    const workdir = await createTempDir();
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    await bindWorkdir(chat.id, workdir);
    const { app, restore } = createAuthenticatedApiTestApp(user, gitRoutes);
    restoreAuth = restore;

    const before = await getState(app, chat.id);
    const beforePayload = (await before.json()) as GitRepoState;
    expect(before.status).toBe(200);
    expect(Value.Check(GitRepoStateSchema, beforePayload)).toBe(true);
    expect(beforePayload).toEqual({ state: 'not-a-repo', workdir });

    const initialized = await app.handle(
      new Request('http://localhost/git/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: chat.id }),
      })
    );
    const initializedPayload = await initialized.json();
    expect(initialized.status).toBe(200);
    expect(Value.Check(InitRepoResponseSchema, initializedPayload)).toBe(true);
    expect(initializedPayload).toEqual({ root: workdir });

    const after = await getState(app, chat.id);
    const afterPayload = (await after.json()) as GitRepoState;
    expect(after.status).toBe(200);
    expect(Value.Check(GitRepoStateSchema, afterPayload)).toBe(true);
    expect(afterPayload.state).toBe('repo');
    if (afterPayload.state === 'repo') {
      expect(afterPayload.root).toBe(workdir);
      expect(afterPayload.status.clean).toBe(true);
    }
  });

  it.skipIf(!hasGit)('reports staged and unstaged edits from a real repository', async () => {
    const workdir = await createTempDir();
    await runFixtureGit(workdir, ['init']);
    // Developer machines may set core.hooksPath globally; point at this repo's
    // own hooks directory so global hooks cannot fail the fixture commit.
    await runFixtureGit(workdir, ['config', 'core.hooksPath', join(workdir, '.git', 'hooks')]);
    await writeFile(join(workdir, 'tracked.txt'), 'initial\n');
    await runFixtureGit(workdir, ['add', 'tracked.txt']);
    await runFixtureGit(workdir, [
      '-c',
      'user.email=git-routes@mangostudio.test',
      '-c',
      'user.name=Git Routes Test',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-m',
      'initial',
    ]);
    await writeFile(join(workdir, 'tracked.txt'), 'staged\n');
    await runFixtureGit(workdir, ['add', 'tracked.txt']);
    await writeFile(join(workdir, 'tracked.txt'), 'unstaged\n');

    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    await bindWorkdir(chat.id, workdir);
    const { app, restore } = createAuthenticatedApiTestApp(user, gitRoutes);
    restoreAuth = restore;

    const response = await getState(app, chat.id);
    const payload = (await response.json()) as GitRepoState;
    expect(response.status).toBe(200);
    expect(Value.Check(GitRepoStateSchema, payload)).toBe(true);
    expect(payload.state).toBe('repo');
    if (payload.state === 'repo') {
      expect(payload.status.staged).toContainEqual({ path: 'tracked.txt', status: 'modified' });
      expect(payload.status.unstaged).toContainEqual({ path: 'tracked.txt', status: 'modified' });
      expect(payload.status.clean).toBe(false);
    }
  });

  it('rejects a chat owned by another user', async () => {
    const [requestingUser, owner] = await Promise.all([insertTestUser(), insertTestUser()]);
    const foreignChat = await insertTestChat(owner.id);
    const { app, restore } = createAuthenticatedApiTestApp(requestingUser, gitRoutes);
    restoreAuth = restore;

    const response = await getState(app, foreignChat.id);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'Chat belongs to another user',
      code: 'OWNERSHIP',
    });
  });

  it('returns no-workdir without invoking Git', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const { app, restore } = createAuthenticatedApiTestApp(user, gitRoutes);
    restoreAuth = restore;

    const response = await getState(app, chat.id);
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(Value.Check(GitRepoStateSchema, payload)).toBe(true);
    expect(payload).toEqual({ state: 'no-workdir' });
  });

  it('requires authentication for status and initialization', async () => {
    const app = createApiTestApp(gitRoutes);
    const state = await app.handle(new Request('http://localhost/git/state?chatId=chat-1'));
    const init = await app.handle(
      new Request('http://localhost/git/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 'chat-1' }),
      })
    );

    expect(state.status).toBe(401);
    expect(init.status).toBe(401);
  });
});
