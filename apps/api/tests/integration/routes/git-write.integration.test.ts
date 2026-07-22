import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_APP_SETTINGS } from '@mangostudio/shared/app-settings';
import {
  type CommitResponse,
  CommitResponseSchema,
  type GitStatus,
  GitStatusSchema,
  type StashListResponse,
  StashListResponseSchema,
} from '@mangostudio/shared/git';
import { Value } from '@sinclair/typebox/value';
import { getDb } from '../../../src/db/database';
import { updateAppSettings } from '../../../src/modules/app-settings/application/app-settings-service';
import { gitRoutes } from '../../../src/modules/git/http/git-routes';
import { insertTestChat, insertTestUser } from '../../support/factories';
import {
  createApiTestApp,
  createAuthenticatedApiTestApp,
} from '../../support/harness/create-api-test-app';

const hasGit = Bun.which('git') !== null;
const tempDirs: string[] = [];
let restoreAuth: (() => void) | null = null;

async function createTempRepo(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'mango-git-write-routes-')));
  tempDirs.push(path);
  await runFixtureGit(path, ['init']);
  await runFixtureGit(path, ['config', 'user.email', 'git-write@mangostudio.test']);
  await runFixtureGit(path, ['config', 'user.name', 'Git Write Test']);
  await runFixtureGit(path, ['config', 'commit.gpgSign', 'false']);
  return path;
}

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

async function createRouteFixture(workdir: string) {
  const user = await insertTestUser();
  const chat = await insertTestChat(user.id);
  await getDb().updateTable('chats').set({ workdir }).where('id', '=', chat.id).execute();
  const authenticated = createAuthenticatedApiTestApp(user, gitRoutes);
  restoreAuth = authenticated.restore;
  return { app: authenticated.app, chatId: chat.id, user };
}

function postJson(
  app: ReturnType<typeof createAuthenticatedApiTestApp>['app'],
  path: string,
  body: unknown
) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

function getStashes(app: ReturnType<typeof createAuthenticatedApiTestApp>['app'], chatId: string) {
  const url = new URL('http://localhost/git/stashes');
  url.searchParams.set('chatId', chatId);
  return app.handle(new Request(url.toString()));
}

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Git write routes', () => {
  it.skipIf(!hasGit)('stages and unstages explicit paths or the complete index', async () => {
    const workdir = await createTempRepo();
    await writeFile(join(workdir, 'tracked.txt'), 'initial\n');
    await runFixtureGit(workdir, ['add', 'tracked.txt']);
    await runFixtureGit(workdir, ['commit', '-m', 'initial']);
    await writeFile(join(workdir, 'tracked.txt'), 'changed\n');
    await writeFile(join(workdir, 'untracked.txt'), 'new\n');
    const { app, chatId } = await createRouteFixture(workdir);

    const stagedPath = await postJson(app, '/git/stage', {
      chatId,
      paths: ['tracked.txt'],
    });
    const stagedPathPayload = (await stagedPath.json()) as GitStatus;
    expect(stagedPath.status).toBe(200);
    expect(Value.Check(GitStatusSchema, stagedPathPayload)).toBe(true);
    expect(stagedPathPayload.staged).toContainEqual({ path: 'tracked.txt', status: 'modified' });
    expect(stagedPathPayload.untracked).toContainEqual({
      path: 'untracked.txt',
      status: 'untracked',
    });

    const stagedAll = await postJson(app, '/git/stage', { chatId, all: true });
    const stagedAllPayload = (await stagedAll.json()) as GitStatus;
    expect(stagedAll.status).toBe(200);
    expect(stagedAllPayload.staged).toContainEqual({ path: 'untracked.txt', status: 'added' });

    const unstagedPath = await postJson(app, '/git/unstage', {
      chatId,
      paths: ['tracked.txt'],
    });
    const unstagedPathPayload = (await unstagedPath.json()) as GitStatus;
    expect(unstagedPath.status).toBe(200);
    expect(unstagedPathPayload.unstaged).toContainEqual({
      path: 'tracked.txt',
      status: 'modified',
    });

    const unstagedAll = await postJson(app, '/git/unstage', { chatId, all: true });
    const unstagedAllPayload = (await unstagedAll.json()) as GitStatus;
    expect(unstagedAll.status).toBe(200);
    expect(unstagedAllPayload.staged).toEqual([]);
    expect(unstagedAllPayload.untracked).toContainEqual({
      path: 'untracked.txt',
      status: 'untracked',
    });
  });

  it.skipIf(!hasGit)('refuses to widen a selection through a magic pathspec', async () => {
    const workdir = await createTempRepo();
    await writeFile(join(workdir, 'tracked.txt'), 'initial\n');
    await runFixtureGit(workdir, ['add', 'tracked.txt']);
    await runFixtureGit(workdir, ['commit', '-m', 'initial']);
    await writeFile(join(workdir, 'tracked.txt'), 'changed\n');
    await writeFile(join(workdir, 'secret.txt'), 'not selected\n');
    const { app, chatId } = await createRouteFixture(workdir);

    // `:/` means "everything from the repository top" and survives `--`, so
    // without literal pathspecs this single entry would stage secret.txt too.
    const staged = await postJson(app, '/git/stage', { chatId, paths: [':/'] });

    expect(staged.status).toBe(422);
    expect(await staged.json()).toMatchObject({ code: 'GIT_COMMAND_FAILED' });

    const state = await postJson(app, '/git/unstage', { chatId, all: true });
    const payload = (await state.json()) as GitStatus;
    expect(payload.staged).toEqual([]);
    expect(payload.untracked).toContainEqual({ path: 'secret.txt', status: 'untracked' });
  });

  it.skipIf(!hasGit)(
    'unstages an explicit path before the repository has a first commit',
    async () => {
      const workdir = await createTempRepo();
      await writeFile(join(workdir, 'first.txt'), 'first\n');
      const { app, chatId } = await createRouteFixture(workdir);

      const staged = await postJson(app, '/git/stage', { chatId, paths: ['first.txt'] });
      expect(staged.status).toBe(200);

      const unstaged = await postJson(app, '/git/unstage', { chatId, paths: ['first.txt'] });
      const payload = (await unstaged.json()) as GitStatus;
      expect(unstaged.status).toBe(200);
      expect(payload.staged).toEqual([]);
      expect(payload.untracked).toContainEqual({ path: 'first.txt', status: 'untracked' });
    }
  );

  it.skipIf(!hasGit)(
    'commits title and body, applies sign-off settings, and amends HEAD',
    async () => {
      const workdir = await createTempRepo();
      await writeFile(join(workdir, 'tracked.txt'), 'first\n');
      const { app, chatId, user } = await createRouteFixture(workdir);
      await postJson(app, '/git/stage', { chatId, all: true });

      const committed = await postJson(app, '/git/commit', {
        chatId,
        title: '  initial subject  ',
        body: 'Commit body text',
      });
      const committedPayload = (await committed.json()) as CommitResponse;
      expect(committed.status).toBe(200);
      expect(Value.Check(CommitResponseSchema, committedPayload)).toBe(true);
      expect(committedPayload.subject).toBe('initial subject');
      expect(await runFixtureGit(workdir, ['log', '-1', '--format=%s%x00%b'])).toBe(
        'initial subject\0Commit body text'
      );

      await updateAppSettings(getDb(), user.id, {
        ...DEFAULT_APP_SETTINGS,
        gitSettings: { ...DEFAULT_APP_SETTINGS.gitSettings, signCommits: false, signOff: true },
      });
      await writeFile(join(workdir, 'tracked.txt'), 'second\n');
      await postJson(app, '/git/stage', { chatId, all: true });

      const signedOff = await postJson(app, '/git/commit', {
        chatId,
        title: 'signed off subject',
      });
      expect(signedOff.status).toBe(200);
      expect(await runFixtureGit(workdir, ['log', '-1', '--format=%B'])).toContain(
        'Signed-off-by: Git Write Test <git-write@mangostudio.test>'
      );

      const beforeAmend = await runFixtureGit(workdir, ['rev-parse', 'HEAD']);
      const amended = await postJson(app, '/git/commit', {
        chatId,
        title: 'amended subject',
        amend: true,
      });
      const amendedPayload = (await amended.json()) as CommitResponse;
      expect(amended.status).toBe(200);
      expect(amendedPayload.subject).toBe('amended subject');
      expect(amendedPayload.hash).not.toBe(beforeAmend);
      expect(await runFixtureGit(workdir, ['log', '-1', '--format=%s'])).toBe('amended subject');
    }
  );

  it.skipIf(!hasGit)(
    'returns typed commit errors for an empty index and amend without HEAD',
    async () => {
      const emptyRepo = await createTempRepo();
      const { app, chatId } = await createRouteFixture(emptyRepo);

      const nothingToCommit = await postJson(app, '/git/commit', {
        chatId,
        title: 'nothing yet',
      });
      expect(nothingToCommit.status).toBe(409);
      expect(await nothingToCommit.json()).toMatchObject({ code: 'NOTHING_TO_COMMIT' });

      const amendWithoutHead = await postJson(app, '/git/commit', {
        chatId,
        title: 'missing head',
        amend: true,
      });
      expect(amendWithoutHead.status).toBe(409);
      expect(await amendWithoutHead.json()).toMatchObject({ code: 'AMEND_WITHOUT_HEAD' });
    }
  );

  it.skipIf(!hasGit)('serializes concurrent commits for the same working directory', async () => {
    const workdir = await createTempRepo();
    const hooksDir = join(workdir, '.git', 'hooks');
    await mkdir(hooksDir, { recursive: true });
    const preCommitHook = join(hooksDir, 'pre-commit');
    const postCommitHook = join(hooksDir, 'post-commit');
    await writeFile(preCommitHook, '#!/bin/sh\nsleep 0.2\n');
    await writeFile(
      postCommitHook,
      '#!/bin/sh\nprintf next >> serialized.txt\ngit add serialized.txt\n'
    );
    await Promise.all([chmod(preCommitHook, 0o755), chmod(postCommitHook, 0o755)]);
    await writeFile(join(workdir, 'seed.txt'), 'seed\n');
    await runFixtureGit(workdir, ['add', 'seed.txt']);
    const { app, chatId } = await createRouteFixture(workdir);

    const [first, second] = await Promise.all([
      postJson(app, '/git/commit', { chatId, title: 'first serialized commit' }),
      postJson(app, '/git/commit', { chatId, title: 'second serialized commit' }),
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await runFixtureGit(workdir, ['rev-list', '--count', 'HEAD'])).toBe('2');
    expect((await runFixtureGit(workdir, ['log', '-2', '--format=%s'])).split('\n').sort()).toEqual(
      ['first serialized commit', 'second serialized commit']
    );
  });

  it.skipIf(!hasGit)('returns hook stderr as actionable commit failure detail', async () => {
    const workdir = await createTempRepo();
    const hookPath = join(workdir, '.git', 'hooks', 'pre-commit');
    await writeFile(hookPath, '#!/bin/sh\necho "project hook rejected commit" >&2\nexit 1\n');
    await chmod(hookPath, 0o755);
    await writeFile(join(workdir, 'tracked.txt'), 'content\n');
    await runFixtureGit(workdir, ['add', 'tracked.txt']);
    const { app, chatId } = await createRouteFixture(workdir);

    const response = await postJson(app, '/git/commit', { chatId, title: 'rejected commit' });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: 'GIT_COMMAND_FAILED',
      details: { stderr: 'project hook rejected commit' },
    });
  });

  it.skipIf(!hasGit)('rejects escaping paths before they reach Git', async () => {
    const workdir = await createTempRepo();
    const { app, chatId } = await createRouteFixture(workdir);

    const response = await postJson(app, '/git/stage', {
      chatId,
      paths: ['../outside.txt'],
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'VALIDATION' });
  });

  it.skipIf(!hasGit)('reports a busy Git index as a retryable typed conflict', async () => {
    const workdir = await createTempRepo();
    await writeFile(join(workdir, 'locked.txt'), 'content\n');
    await writeFile(join(workdir, '.git', 'index.lock'), 'held by another Git process');
    const { app, chatId } = await createRouteFixture(workdir);

    const response = await postJson(app, '/git/stage', { chatId, all: true });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'GIT_LOCKED',
      details: { stderr: expect.stringContaining('index.lock') },
    });
  });

  it.skipIf(!hasGit)('saves, lists, and pops tracked and untracked stash changes', async () => {
    const workdir = await createTempRepo();
    await writeFile(join(workdir, 'tracked.txt'), 'initial\n');
    await runFixtureGit(workdir, ['add', 'tracked.txt']);
    await runFixtureGit(workdir, ['commit', '-m', 'initial']);
    const branch = await runFixtureGit(workdir, ['branch', '--show-current']);
    await writeFile(join(workdir, 'tracked.txt'), 'stashed\n');
    await writeFile(join(workdir, 'untracked.txt'), 'untracked\n');
    const { app, chatId } = await createRouteFixture(workdir);

    const saved = await postJson(app, '/git/stash', {
      chatId,
      message: 'panel work',
      includeUntracked: true,
    });
    const savedPayload = await saved.json();
    expect(saved.status).toBe(200);
    expect(savedPayload).toMatchObject({ state: 'repo', status: { clean: true } });

    const listed = await getStashes(app, chatId);
    const listedPayload = (await listed.json()) as StashListResponse;
    expect(listed.status).toBe(200);
    expect(Value.Check(StashListResponseSchema, listedPayload)).toBe(true);
    expect(listedPayload.stashes).toEqual([{ index: 0, branch, message: 'panel work' }]);

    const popped = await postJson(app, '/git/stash/pop', { chatId });
    const poppedPayload = await popped.json();
    expect(popped.status).toBe(200);
    expect(poppedPayload).toMatchObject({
      state: 'repo',
      status: {
        unstaged: [{ path: 'tracked.txt', status: 'modified' }],
        untracked: [{ path: 'untracked.txt', status: 'untracked' }],
      },
    });
    const stashesAfterPop = (await (await getStashes(app, chatId)).json()) as StashListResponse;
    expect(stashesAfterPop.stashes).toEqual([]);
  });

  it.skipIf(!hasGit)('reports stash-pop conflicts and leaves conflict state visible', async () => {
    const workdir = await createTempRepo();
    await writeFile(join(workdir, 'conflict.txt'), 'base\n');
    await runFixtureGit(workdir, ['add', 'conflict.txt']);
    await runFixtureGit(workdir, ['commit', '-m', 'base']);
    await writeFile(join(workdir, 'conflict.txt'), 'stashed version\n');
    const { app, chatId } = await createRouteFixture(workdir);
    await postJson(app, '/git/stash', { chatId, message: 'conflicting work' });
    await writeFile(join(workdir, 'conflict.txt'), 'current version\n');
    await runFixtureGit(workdir, ['add', 'conflict.txt']);
    await runFixtureGit(workdir, ['commit', '-m', 'current']);

    const popped = await postJson(app, '/git/stash/pop', { chatId, index: 0 });
    expect(popped.status).toBe(409);
    expect(await popped.json()).toMatchObject({ code: 'STASH_CONFLICT' });

    const statusOutput = await runFixtureGit(workdir, ['status', '--porcelain']);
    expect(statusOutput).toContain('UU conflict.txt');
  });

  it('enforces chat ownership for every write and stash-list route', async () => {
    const [requestingUser, owner] = await Promise.all([insertTestUser(), insertTestUser()]);
    const foreignChat = await insertTestChat(owner.id);
    const authenticated = createAuthenticatedApiTestApp(requestingUser, gitRoutes);
    restoreAuth = authenticated.restore;

    const responses = await Promise.all([
      postJson(authenticated.app, '/git/stage', {
        chatId: foreignChat.id,
        paths: ['file.txt'],
      }),
      postJson(authenticated.app, '/git/unstage', {
        chatId: foreignChat.id,
        paths: ['file.txt'],
      }),
      postJson(authenticated.app, '/git/commit', {
        chatId: foreignChat.id,
        title: 'foreign commit',
      }),
      postJson(authenticated.app, '/git/commit-message', { chatId: foreignChat.id }),
      postJson(authenticated.app, '/git/stash', { chatId: foreignChat.id }),
      postJson(authenticated.app, '/git/stash/pop', { chatId: foreignChat.id }),
      getStashes(authenticated.app, foreignChat.id),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'OWNERSHIP' });
    }
  });

  it('requires authentication for every write and stash-list route', async () => {
    const app = createApiTestApp(gitRoutes);
    const responses = await Promise.all([
      postJson(app, '/git/stage', { chatId: 'chat-1', paths: ['file.txt'] }),
      postJson(app, '/git/unstage', { chatId: 'chat-1', paths: ['file.txt'] }),
      postJson(app, '/git/commit', { chatId: 'chat-1', title: 'unauthorized commit' }),
      postJson(app, '/git/commit-message', { chatId: 'chat-1' }),
      postJson(app, '/git/stash', { chatId: 'chat-1' }),
      postJson(app, '/git/stash/pop', { chatId: 'chat-1' }),
      getStashes(app, 'chat-1'),
    ]);

    for (const response of responses) expect(response.status).toBe(401);
  });

  it('returns conflict and not found when staging requires a bound workdir', async () => {
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    const authenticated = createAuthenticatedApiTestApp(user, gitRoutes);
    restoreAuth = authenticated.restore;

    const noWorkdir = await postJson(authenticated.app, '/git/stage', {
      chatId: chat.id,
      paths: ['file.txt'],
    });
    expect(noWorkdir.status).toBe(409);
    expect(await noWorkdir.json()).toEqual({
      error: 'Chat has no working directory',
      code: 'CONFLICT',
    });

    const missing = await postJson(authenticated.app, '/git/stage', {
      chatId: 'chat-does-not-exist',
      paths: ['file.txt'],
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Chat not found', code: 'NOT_FOUND' });
  });

  it.skipIf(!hasGit)('discards tracked worktree changes without clearing the index', async () => {
    const workdir = await createTempRepo();
    await writeFile(join(workdir, 'tracked.txt'), 'initial\n');
    await runFixtureGit(workdir, ['add', 'tracked.txt']);
    await runFixtureGit(workdir, ['commit', '-m', 'initial']);
    await writeFile(join(workdir, 'tracked.txt'), 'staged\n');
    await runFixtureGit(workdir, ['add', 'tracked.txt']);
    await writeFile(join(workdir, 'tracked.txt'), 'worktree\n');
    const { app, chatId } = await createRouteFixture(workdir);

    const discarded = await postJson(app, '/git/discard', {
      chatId,
      paths: ['tracked.txt'],
      mode: 'tracked',
    });
    const payload = (await discarded.json()) as GitStatus;
    expect(discarded.status).toBe(200);
    expect(Value.Check(GitStatusSchema, payload)).toBe(true);
    expect(payload.staged).toContainEqual({ path: 'tracked.txt', status: 'modified' });
    expect(payload.unstaged).toEqual([]);
    expect(await Bun.file(join(workdir, 'tracked.txt')).text()).toBe('staged\n');
  });

  it.skipIf(!hasGit)(
    'deletes only selected untracked files and rejects tracked paths',
    async () => {
      const workdir = await createTempRepo();
      await writeFile(join(workdir, 'tracked.txt'), 'initial\n');
      await runFixtureGit(workdir, ['add', 'tracked.txt']);
      await runFixtureGit(workdir, ['commit', '-m', 'initial']);
      await writeFile(join(workdir, 'keep.txt'), 'keep\n');
      await writeFile(join(workdir, 'drop.txt'), 'drop\n');
      const { app, chatId } = await createRouteFixture(workdir);

      const rejected = await postJson(app, '/git/discard', {
        chatId,
        paths: ['tracked.txt'],
        mode: 'untracked',
      });
      expect(rejected.status).toBe(422);

      const deleted = await postJson(app, '/git/discard', {
        chatId,
        paths: ['drop.txt'],
        mode: 'untracked',
      });
      const payload = (await deleted.json()) as GitStatus;
      expect(deleted.status).toBe(200);
      expect(payload.untracked).toContainEqual({ path: 'keep.txt', status: 'untracked' });
      expect(payload.untracked.some((change) => change.path === 'drop.txt')).toBe(false);
      expect(await Bun.file(join(workdir, 'keep.txt')).exists()).toBe(true);
      expect(await Bun.file(join(workdir, 'drop.txt')).exists()).toBe(false);
    }
  );

  it.skipIf(!hasGit)('lists remote branches and creates a local tracking branch', async () => {
    const bare = await realpath(await mkdtemp(join(tmpdir(), 'mango-git-bare-')));
    tempDirs.push(bare);
    await runFixtureGit(bare, ['init', '--bare']);

    const workdir = await createTempRepo();
    await writeFile(join(workdir, 'readme.txt'), 'hello\n');
    await runFixtureGit(workdir, ['add', 'readme.txt']);
    await runFixtureGit(workdir, ['commit', '-m', 'initial']);
    await runFixtureGit(workdir, ['branch', '-M', 'main']);
    await runFixtureGit(workdir, ['remote', 'add', 'origin', bare]);
    await runFixtureGit(workdir, ['push', '-u', 'origin', 'main']);
    await runFixtureGit(workdir, ['checkout', '-b', 'feat/remote-only']);
    await writeFile(join(workdir, 'feature.txt'), 'feature\n');
    await runFixtureGit(workdir, ['add', 'feature.txt']);
    await runFixtureGit(workdir, ['commit', '-m', 'feature']);
    await runFixtureGit(workdir, ['push', '-u', 'origin', 'feat/remote-only']);
    await runFixtureGit(workdir, ['checkout', 'main']);
    await runFixtureGit(workdir, ['branch', '-D', 'feat/remote-only']);

    const { app, chatId } = await createRouteFixture(workdir);
    const branchesUrl = new URL('http://localhost/git/branches');
    branchesUrl.searchParams.set('chatId', chatId);
    const listed = await app.handle(new Request(branchesUrl.toString()));
    const listedPayload = (await listed.json()) as {
      branches: Array<{ name: string }>;
      remotes: Array<{ name: string; remote: string; ref: string }>;
    };
    expect(listed.status).toBe(200);
    expect(listedPayload.remotes).toContainEqual({
      name: 'feat/remote-only',
      remote: 'origin',
      ref: 'origin/feat/remote-only',
    });

    const checkedOut = await postJson(app, '/git/branches/checkout-remote', {
      chatId,
      remoteRef: 'origin/feat/remote-only',
    });
    expect(checkedOut.status).toBe(200);
    const state = (await checkedOut.json()) as { status: { branch: { name: string | null } } };
    expect(state.status.branch.name).toBe('feat/remote-only');
  });
});
