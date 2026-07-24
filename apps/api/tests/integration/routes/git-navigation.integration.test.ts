import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GitBranchesResponseSchema,
  type GitCommitDetailsResponse,
  GitCommitDetailsResponseSchema,
  type GitDiffResponse,
  GitDiffResponseSchema,
  type GitHistoryResponse,
  GitHistoryResponseSchema,
  type GitRepoState,
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
/** Heavy git fixtures (many commits / remotes) need headroom beyond Bun's 5s default. */
const GIT_NAVIGATION_TIMEOUT_MS = 15_000;
const tempDirs: string[] = [];
let restoreAuth: (() => void) | null = null;

async function tempDirectory(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  tempDirs.push(path);
  return path;
}

async function createTempRepo(): Promise<string> {
  const path = await tempDirectory('mango-git-navigation-');
  await fixtureGit(path, ['init', '-b', 'main']);
  await fixtureGit(path, ['config', 'user.email', 'git-navigation@mangostudio.test']);
  await fixtureGit(path, ['config', 'user.name', 'Git Navigation Test']);
  await fixtureGit(path, ['config', 'commit.gpgSign', 'false']);
  return path;
}

async function fixtureGit(cwd: string, args: readonly string[]): Promise<string> {
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

async function createRouteFixture(workdir: string) {
  const user = await insertTestUser();
  const chat = await insertTestChat(user.id);
  await getDb().updateTable('chats').set({ workdir }).where('id', '=', chat.id).execute();
  const authenticated = createAuthenticatedApiTestApp(user, gitRoutes);
  restoreAuth = authenticated.restore;
  return { app: authenticated.app, chatId: chat.id, user };
}

type TestApp = ReturnType<typeof createAuthenticatedApiTestApp>['app'];

function postJson(app: TestApp, path: string, body: unknown) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

function getRoute(app: TestApp, path: string, query: Record<string, string>) {
  const url = new URL(`http://localhost${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return app.handle(new Request(url.toString()));
}

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Git navigation routes', () => {
  it.skipIf(!hasGit)(
    'lists, creates, and safely switches local branches',
    async () => {
      const workdir = await createTempRepo();
      await writeFile(join(workdir, 'shared.txt'), 'base\n');
      await fixtureGit(workdir, ['add', 'shared.txt']);
      await fixtureGit(workdir, ['commit', '-m', 'base']);
      const { app, chatId } = await createRouteFixture(workdir);

      const optionInjection = await postJson(app, '/git/branches/switch', {
        chatId,
        name: '--detach',
      });
      expect(optionInjection.status).toBe(422);
      expect(await fixtureGit(workdir, ['branch', '--show-current'])).toBe('main');

      const created = await postJson(app, '/git/branches', { chatId, name: 'feat/navigation' });
      expect(created.status).toBe(200);
      expect((await created.json()) as GitRepoState).toMatchObject({
        state: 'repo',
        status: { branch: { name: 'feat/navigation' } },
      });

      await writeFile(join(workdir, 'shared.txt'), 'feature\n');
      await fixtureGit(workdir, ['add', 'shared.txt']);
      await fixtureGit(workdir, ['commit', '-m', 'feature version']);
      expect((await postJson(app, '/git/branches/switch', { chatId, name: 'main' })).status).toBe(
        200
      );

      const listed = await getRoute(app, '/git/branches', { chatId });
      const listedPayload = await listed.json();
      expect(listed.status).toBe(200);
      expect(Value.Check(GitBranchesResponseSchema, listedPayload)).toBe(true);
      expect(listedPayload).toMatchObject({
        branches: [
          { name: 'main', current: true },
          { name: 'feat/navigation', current: false },
        ],
      });

      await writeFile(join(workdir, 'shared.txt'), 'local work\n');
      const blocked = await postJson(app, '/git/branches/switch', {
        chatId,
        name: 'feat/navigation',
      });
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({
        code: 'CHECKOUT_BLOCKED',
        details: { paths: 'shared.txt' },
      });
    },
    GIT_NAVIGATION_TIMEOUT_MS
  );

  it.skipIf(!hasGit)(
    'paginates history and returns worktree, staged, and commit diffs',
    async () => {
      const workdir = await createTempRepo();
      for (let index = 0; index < 22; index++) {
        await writeFile(join(workdir, 'history.ts'), `export const value = ${index};\n`);
        await fixtureGit(workdir, ['add', 'history.ts']);
        await fixtureGit(workdir, ['commit', '-m', `history ${index}`]);
      }
      const { app, chatId } = await createRouteFixture(workdir);

      const firstPage = await getRoute(app, '/git/history', { chatId });
      const firstPayload = (await firstPage.json()) as GitHistoryResponse;
      expect(firstPage.status).toBe(200);
      expect(Value.Check(GitHistoryResponseSchema, firstPayload)).toBe(true);
      expect(firstPayload.commits).toHaveLength(20);
      expect(firstPayload.nextCursor).toBe('20');

      const secondPage = await getRoute(app, '/git/history', {
        chatId,
        cursor: firstPayload.nextCursor ?? '20',
      });
      expect(secondPage.status).toBe(200);
      const secondPayload = (await secondPage.json()) as GitHistoryResponse;
      expect(Value.Check(GitHistoryResponseSchema, secondPayload)).toBe(true);
      expect(secondPayload.commits).toHaveLength(2);
      expect(secondPayload.nextCursor).toBeUndefined();

      const selectedHash = firstPayload.commits[0]?.hash;
      expect(selectedHash).toBeTruthy();
      const details = await getRoute(app, '/git/commit', { chatId, hash: selectedHash as string });
      expect(details.status).toBe(200);
      const detailsPayload = (await details.json()) as GitCommitDetailsResponse;
      expect(Value.Check(GitCommitDetailsResponseSchema, detailsPayload)).toBe(true);
      expect(detailsPayload.files).toContainEqual(
        expect.objectContaining({ path: 'history.ts', status: 'modified' })
      );

      await writeFile(join(workdir, 'history.ts'), 'export const value = 100;\n');
      const worktreeDiff = await getRoute(app, '/git/diff', { chatId, path: 'history.ts' });
      expect(worktreeDiff.status).toBe(200);
      const worktreePayload = (await worktreeDiff.json()) as GitDiffResponse;
      expect(Value.Check(GitDiffResponseSchema, worktreePayload)).toBe(true);
      expect(worktreePayload.diff).toContain('+export const value = 100;');

      await fixtureGit(workdir, ['add', 'history.ts']);
      const stagedDiff = await getRoute(app, '/git/diff', {
        chatId,
        path: 'history.ts',
        staged: 'true',
      });
      expect(stagedDiff.status).toBe(200);
      const stagedPayload = (await stagedDiff.json()) as GitDiffResponse;
      expect(Value.Check(GitDiffResponseSchema, stagedPayload)).toBe(true);
      expect(stagedPayload.diff).toContain('+export const value = 100;');

      const commitDiff = await getRoute(app, '/git/diff', {
        chatId,
        path: 'history.ts',
        commit: selectedHash as string,
      });
      expect(commitDiff.status).toBe(200);
      const commitPayload = (await commitDiff.json()) as GitDiffResponse;
      expect(Value.Check(GitDiffResponseSchema, commitPayload)).toBe(true);
      expect(commitPayload.diff).toContain('+export const value = 21;');

      await writeFile(join(workdir, 'untracked.ts'), 'export const untracked = true;\n');
      const untrackedDiff = await getRoute(app, '/git/diff', { chatId, path: 'untracked.ts' });
      expect(untrackedDiff.status).toBe(200);
      const untrackedPayload = (await untrackedDiff.json()) as GitDiffResponse;
      expect(Value.Check(GitDiffResponseSchema, untrackedPayload)).toBe(true);
      expect(untrackedPayload.diff).toContain('+export const untracked = true;');

      await fixtureGit(workdir, ['restore', '--staged', '--worktree', 'history.ts']);
      await fixtureGit(workdir, ['mv', 'history.ts', 'renamed-history.ts']);
      await fixtureGit(workdir, ['commit', '-m', 'rename history']);
      const renameHash = await fixtureGit(workdir, ['rev-parse', 'HEAD']);
      expect(renameHash).toMatch(/^[0-9a-f]{40}$/);
      const renameResponse = await getRoute(app, '/git/commit', { chatId, hash: renameHash });
      expect(renameResponse.status).toBe(200);
      const renameDetails = (await renameResponse.json()) as GitCommitDetailsResponse;
      expect(Value.Check(GitCommitDetailsResponseSchema, renameDetails)).toBe(true);
      expect(renameDetails.commit.changedFiles).toBe(1);
      expect(renameDetails.files).toContainEqual(
        expect.objectContaining({
          path: 'renamed-history.ts',
          oldPath: 'history.ts',
          status: 'renamed',
        })
      );
    },
    GIT_NAVIGATION_TIMEOUT_MS
  );

  it.skipIf(!hasGit)(
    'keeps diff reads inside the repository root',
    async () => {
      const workdir = await createTempRepo();
      await writeFile(join(workdir, 'tracked.txt'), 'base\n');
      await fixtureGit(workdir, ['add', 'tracked.txt']);
      await fixtureGit(workdir, ['commit', '-m', 'base']);

      const outside = await tempDirectory('mango-git-outside-');
      await writeFile(join(outside, 'secret.txt'), 'TOPSECRET\n');
      // An untracked directory symlink escapes a purely lexical containment check,
      // and `git diff --no-index` follows it where Git's own worktree walk will not.
      await symlink(outside, join(workdir, 'escape'));

      const { app, chatId } = await createRouteFixture(workdir);

      const traversal = await getRoute(app, '/git/diff', { chatId, path: '../secret.txt' });
      expect(traversal.status).toBe(422);

      const viaSymlink = await getRoute(app, '/git/diff', { chatId, path: 'escape/secret.txt' });
      expect(viaSymlink.status).toBe(422);
      expect(JSON.stringify(await viaSymlink.json())).not.toContain('TOPSECRET');
    },
    GIT_NAVIGATION_TIMEOUT_MS
  );

  it.skipIf(!hasGit)(
    'pushes, fetches, pulls fast-forward, and rejects divergence',
    async () => {
      const remote = await tempDirectory('mango-git-remote-');
      await fixtureGit(remote, ['init', '--bare', '-b', 'main']);
      const workdir = await createTempRepo();
      await writeFile(join(workdir, 'remote.txt'), 'base\n');
      await fixtureGit(workdir, ['add', 'remote.txt']);
      await fixtureGit(workdir, ['commit', '-m', 'base']);
      await fixtureGit(workdir, ['remote', 'add', 'origin', remote]);
      const { app, chatId } = await createRouteFixture(workdir);

      const firstPush = await postJson(app, '/git/push', { chatId });
      expect(firstPush.status).toBe(200);
      expect(await fixtureGit(workdir, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe(
        'origin/main'
      );

      const peerParent = await tempDirectory('mango-git-peer-');
      await fixtureGit(peerParent, ['clone', remote, 'peer']);
      const peer = join(peerParent, 'peer');
      await fixtureGit(peer, ['config', 'user.email', 'peer@mangostudio.test']);
      await fixtureGit(peer, ['config', 'user.name', 'Peer Test']);
      await fixtureGit(peer, ['config', 'commit.gpgSign', 'false']);
      await writeFile(join(peer, 'remote.txt'), 'remote ahead\n');
      await fixtureGit(peer, ['add', 'remote.txt']);
      await fixtureGit(peer, ['commit', '-m', 'remote ahead']);
      await fixtureGit(peer, ['push']);

      const fetched = await postJson(app, '/git/fetch', { chatId, prune: true });
      expect(fetched.status).toBe(200);
      expect((await fetched.json()) as GitRepoState).toMatchObject({
        state: 'repo',
        status: { branch: { behind: 1 } },
      });
      expect((await postJson(app, '/git/pull', { chatId })).status).toBe(200);
      expect(await fixtureGit(workdir, ['show', 'HEAD:remote.txt'])).toBe('remote ahead');

      await writeFile(join(workdir, 'local.txt'), 'local\n');
      await fixtureGit(workdir, ['add', 'local.txt']);
      await fixtureGit(workdir, ['commit', '-m', 'local ahead']);
      await writeFile(join(peer, 'peer.txt'), 'peer\n');
      await fixtureGit(peer, ['add', 'peer.txt']);
      await fixtureGit(peer, ['commit', '-m', 'peer ahead']);
      await fixtureGit(peer, ['push']);

      const nonFastForward = await postJson(app, '/git/pull', { chatId });
      expect(nonFastForward.status).toBe(409);
      expect(await nonFastForward.json()).toMatchObject({ code: 'NON_FAST_FORWARD' });

      const divergedPush = await postJson(app, '/git/push', { chatId });
      expect(divergedPush.status).toBe(409);
      expect(await divergedPush.json()).toMatchObject({ code: 'HISTORY_DIVERGED' });
    },
    GIT_NAVIGATION_TIMEOUT_MS
  );

  it('enforces authentication and chat ownership on navigation routes', async () => {
    const unauthenticated = createApiTestApp(gitRoutes);
    const unauthorized = await Promise.all([
      getRoute(unauthenticated, '/git/branches', { chatId: 'chat-1' }),
      getRoute(unauthenticated, '/git/history', { chatId: 'chat-1' }),
      postJson(unauthenticated, '/git/push', { chatId: 'chat-1' }),
    ]);
    for (const response of unauthorized) expect(response.status).toBe(401);

    const [requestingUser, owner] = await Promise.all([insertTestUser(), insertTestUser()]);
    const foreignChat = await insertTestChat(owner.id);
    const authenticated = createAuthenticatedApiTestApp(requestingUser, gitRoutes);
    restoreAuth = authenticated.restore;
    const forbidden = await Promise.all([
      getRoute(authenticated.app, '/git/branches', { chatId: foreignChat.id }),
      getRoute(authenticated.app, '/git/history', { chatId: foreignChat.id }),
      postJson(authenticated.app, '/git/fetch', { chatId: foreignChat.id }),
    ]);
    for (const response of forbidden) expect(response.status).toBe(403);
  });

  it('returns conflict when navigation routes require a bound workdir', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const authenticated = createAuthenticatedApiTestApp(user, gitRoutes);
    restoreAuth = authenticated.restore;

    const response = await getRoute(authenticated.app, '/git/branches', { chatId: chat.id });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Chat has no working directory',
      code: 'CONFLICT',
    });
  });

  it('returns not found when the chat id does not exist', async () => {
    const user = await insertTestUser();
    const authenticated = createAuthenticatedApiTestApp(user, gitRoutes);
    restoreAuth = authenticated.restore;

    const response = await getRoute(authenticated.app, '/git/branches', {
      chatId: 'chat-does-not-exist',
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Chat not found', code: 'NOT_FOUND' });
  });
});
