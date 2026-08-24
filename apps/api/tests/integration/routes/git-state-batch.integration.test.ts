import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type GitBatchStateResponse,
  GitBatchStateResponseSchema,
  type GitSummary,
} from '@mangostudio/shared/git';
import Value from 'typebox/value';
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
  const path = await mkdtemp(join(tmpdir(), 'mango-git-batch-'));
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

async function createFixtureRepo(): Promise<string> {
  const workdir = await createTempDir();
  await runFixtureGit(workdir, ['init', '--initial-branch=main']);
  // Developer machines may set core.hooksPath globally; point at this repo's
  // own hooks directory so global hooks cannot fail the fixture commit.
  await runFixtureGit(workdir, ['config', 'core.hooksPath', join(workdir, '.git', 'hooks')]);
  await writeFile(join(workdir, 'tracked.txt'), 'initial\n');
  await runFixtureGit(workdir, ['add', 'tracked.txt']);
  await runFixtureGit(workdir, [
    '-c',
    'user.email=git-batch@mangostudio.test',
    '-c',
    'user.name=Git Batch Test',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-m',
    'initial',
  ]);
  return workdir;
}

function postBatch(
  app:
    | ReturnType<typeof createAuthenticatedApiTestApp>['app']
    | ReturnType<typeof createApiTestApp>,
  chatIds: readonly string[]
) {
  return app.handle(
    new Request('http://localhost/git/state/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatIds }),
    })
  );
}

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('POST /git/state/batch', () => {
  it.skipIf(!hasGit)(
    'answers every requested chat, sharing one status read per workdir',
    async () => {
      const repo = await createFixtureRepo();
      await writeFile(join(repo, 'tracked.txt'), 'dirty\n');
      await writeFile(join(repo, 'untracked.txt'), 'new\n');
      const emptyDir = await createTempDir();

      const [user, otherUser] = await Promise.all([insertTestUser(), insertTestUser()]);
      const [inRepoA, inRepoB, notARepo, noWorkdir, foreign] = await Promise.all([
        insertTestChat(user.id),
        insertTestChat(user.id),
        insertTestChat(user.id),
        insertTestChat(user.id),
        insertTestChat(otherUser.id),
      ]);
      await Promise.all([
        bindWorkdir(inRepoA.id, repo),
        bindWorkdir(inRepoB.id, repo),
        bindWorkdir(notARepo.id, emptyDir),
        bindWorkdir(foreign.id, repo),
      ]);
      const { app, restore } = createAuthenticatedApiTestApp(user, gitRoutes);
      restoreAuth = restore;

      const response = await postBatch(app, [
        inRepoA.id,
        inRepoB.id,
        notARepo.id,
        noWorkdir.id,
        foreign.id,
        'does-not-exist',
      ]);
      const payload = (await response.json()) as GitBatchStateResponse;

      expect(response.status).toBe(200);
      expect(Value.Check(GitBatchStateResponseSchema, payload)).toBe(true);
      expect(payload.states[inRepoA.id]).toEqual({
        branch: 'main',
        ahead: 0,
        behind: 0,
        changedFileCount: 2,
        workdir: repo,
      });
      // Same repository, same answer — the batch fans one read out.
      expect(payload.states[inRepoB.id]).toEqual(payload.states[inRepoA.id] as GitSummary);
      // Not-a-repo, no workdir, another user's chat, and an unknown id are all
      // the same absence: the response must not reveal which one it was.
      expect(Object.keys(payload.states).sort()).toEqual([inRepoA.id, inRepoB.id].sort());
    }
  );

  it.skipIf(!hasGit)('reports a clean repository with a zero changed-file count', async () => {
    const repo = await createFixtureRepo();
    const user = await insertTestUser();
    const chat = await insertTestChat(user.id);
    await bindWorkdir(chat.id, repo);
    const { app, restore } = createAuthenticatedApiTestApp(user, gitRoutes);
    restoreAuth = restore;

    const response = await postBatch(app, [chat.id]);
    const payload = (await response.json()) as GitBatchStateResponse;

    expect(response.status).toBe(200);
    expect(payload.states[chat.id]).toEqual({
      branch: 'main',
      ahead: 0,
      behind: 0,
      changedFileCount: 0,
      workdir: repo,
    });
  });

  it('rejects an oversized batch and duplicate ids at the schema boundary', async () => {
    const user = await insertTestUser();
    const { app, restore } = createAuthenticatedApiTestApp(user, gitRoutes);
    restoreAuth = restore;

    const oversized = await postBatch(
      app,
      Array.from({ length: 51 }, (_, index) => `chat-${index}`)
    );
    const duplicated = await postBatch(app, ['chat-1', 'chat-1']);
    const empty = await postBatch(app, []);

    expect(oversized.status).toBe(422);
    expect(duplicated.status).toBe(422);
    expect(empty.status).toBe(422);
  });

  it('requires authentication', async () => {
    const app = createApiTestApp(gitRoutes);
    const response = await postBatch(app, ['chat-1']);
    expect(response.status).toBe(401);
  });
});
