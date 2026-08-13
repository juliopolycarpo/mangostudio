import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_APP_SETTINGS } from '@mangostudio/shared/app-settings';
import {
  type GenerateCommitMessageResponse,
  GenerateCommitMessageResponseSchema,
} from '@mangostudio/shared/git';
import Value from 'typebox/value';
import { getDb } from '../../../src/db/database';
import { updateAppSettings } from '../../../src/modules/app-settings/application/app-settings-service';
import { gitRoutes } from '../../../src/modules/git/http/git-routes';
import {
  getProvider,
  registerProvider,
} from '../../../src/services/providers/core/provider-registry';
import type { AIProvider, TextGenerationRequest } from '../../../src/services/providers/types';
import { insertTestChat, insertTestConnector, insertTestUser } from '../../support/factories';
import { createAuthenticatedApiTestApp } from '../../support/harness/create-api-test-app';

const hasGit = Bun.which('git') !== null;
const tempDirs: string[] = [];
const capturedRequests: TextGenerationRequest[] = [];
let restoreAuth: (() => void) | null = null;
let previousProvider: AIProvider | null = null;
let providerOutput = '';

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

async function createTempRepo(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'mango-commit-message-routes-')));
  tempDirs.push(path);
  await runFixtureGit(path, ['init']);
  await runFixtureGit(path, ['config', 'user.email', 'commit-message@mangostudio.test']);
  await runFixtureGit(path, ['config', 'user.name', 'Commit Message Test']);
  await runFixtureGit(path, ['config', 'commit.gpgSign', 'false']);
  // Developer machines may set core.hooksPath globally (e.g. to force
  // Signed-off-by). Pointing at this repo's own hooks directory outranks
  // the global path.
  await runFixtureGit(path, ['config', 'core.hooksPath', join(path, '.git', 'hooks')]);
  return path;
}

async function seedCommit(workdir: string): Promise<void> {
  await writeFile(join(workdir, 'tracked.txt'), 'initial\n');
  await runFixtureGit(workdir, ['add', 'tracked.txt']);
  await runFixtureGit(workdir, ['commit', '-m', 'chore: seed repository']);
}

function installFakeProvider(): void {
  previousProvider = getProvider('openai-compatible');
  registerProvider({
    ...previousProvider,
    warmup: () => Promise.resolve(),
    generateText: (request) => {
      capturedRequests.push(request);
      return Promise.resolve({ text: providerOutput });
    },
  });
}

async function createRouteFixture(workdir: string, models = ['chat-model']) {
  const user = await insertTestUser();
  const chat = await insertTestChat(user.id);
  await Promise.all([
    getDb()
      .updateTable('chats')
      .set({ workdir, textModel: 'chat-model' })
      .where('id', '=', chat.id)
      .execute(),
    insertTestConnector(user.id, { enabledModels: models }),
  ]);
  const authenticated = createAuthenticatedApiTestApp(user, gitRoutes);
  restoreAuth = authenticated.restore;
  return { app: authenticated.app, chatId: chat.id, user };
}

function generateMessage(
  app: ReturnType<typeof createAuthenticatedApiTestApp>['app'],
  chatId: string,
  model?: string
) {
  return app.handle(
    new Request('http://localhost/git/commit-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, ...(model ? { model } : {}) }),
    })
  );
}

afterEach(async () => {
  restoreAuth?.();
  restoreAuth = null;
  if (previousProvider) registerProvider(previousProvider);
  previousProvider = null;
  providerOutput = '';
  capturedRequests.length = 0;
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Git commit-message generation route', () => {
  it.skipIf(!hasGit)('uses only the staged diff and reports a clipped context', async () => {
    installFakeProvider();
    providerOutput = `Title: feat(git): generate commit messages.

Body:
Build the suggestion from the selected diff.`;
    const workdir = await createTempRepo();
    await seedCommit(workdir);
    await writeFile(
      join(workdir, 'tracked.txt'),
      `staged version\n${'staged filler\n'.repeat(2_000)}`
    );
    await runFixtureGit(workdir, ['add', 'tracked.txt']);
    await writeFile(join(workdir, 'tracked.txt'), 'unstaged version\n', { flag: 'a' });
    const { app, chatId, user } = await createRouteFixture(workdir);
    await updateAppSettings(getDb(), user.id, {
      ...DEFAULT_APP_SETTINGS,
      gitSettings: {
        ...DEFAULT_APP_SETTINGS.gitSettings,
        commitMessage: {
          ...DEFAULT_APP_SETTINGS.gitSettings.commitMessage,
          maxDiffKb: 16,
        },
      },
    });

    const response = await generateMessage(app, chatId);
    const payload = (await response.json()) as GenerateCommitMessageResponse;

    expect(response.status).toBe(200);
    expect(Value.Check(GenerateCommitMessageResponseSchema, payload)).toBe(true);
    expect(payload).toEqual({
      title: 'feat(git): generate commit messages',
      body: 'Build the suggestion from the selected diff.',
      truncated: true,
    });
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.prompt).toContain('Selected diff (staged)');
    expect(capturedRequests[0]?.prompt).toContain('staged version');
    expect(capturedRequests[0]?.prompt).not.toContain('unstaged version');
    expect(capturedRequests[0]?.prompt).toContain('[diff truncated]');
  });

  it.skipIf(!hasGit)(
    'uses worktree changes and untracked names when nothing is staged',
    async () => {
      installFakeProvider();
      providerOutput = 'fix(git): describe worktree changes';
      const workdir = await createTempRepo();
      await seedCommit(workdir);
      await writeFile(join(workdir, 'tracked.txt'), 'worktree version\n');
      await writeFile(join(workdir, 'new-file.txt'), 'untracked content is not sent\n');
      const { app, chatId } = await createRouteFixture(workdir);

      const response = await generateMessage(app, chatId);

      expect(response.status).toBe(200);
      expect(capturedRequests[0]?.prompt).toContain('Selected diff (unstaged)');
      expect(capturedRequests[0]?.prompt).toContain('worktree version');
      expect(capturedRequests[0]?.prompt).toContain(
        'Untracked files (content not included):\n- new-file.txt'
      );
      expect(capturedRequests[0]?.prompt).not.toContain('untracked content is not sent');
      expect(capturedRequests[0]?.prompt).toContain('chore: seed repository');
    }
  );

  it.skipIf(!hasGit)('generates in a repository without HEAD', async () => {
    installFakeProvider();
    providerOutput = 'feat: add first file';
    const workdir = await createTempRepo();
    await writeFile(join(workdir, 'first.txt'), 'first content\n');
    await runFixtureGit(workdir, ['add', 'first.txt']);
    const { app, chatId } = await createRouteFixture(workdir);

    const response = await generateMessage(app, chatId);

    expect(response.status).toBe(200);
    expect(capturedRequests[0]?.prompt).toContain('Recent commit subjects:\n- (no commits yet)');
  });

  it.skipIf(!hasGit)(
    'resolves request, preference, and chat models in priority order',
    async () => {
      installFakeProvider();
      providerOutput = 'feat(git): resolve generation model';
      const workdir = await createTempRepo();
      await seedCommit(workdir);
      await writeFile(join(workdir, 'tracked.txt'), 'changed\n');
      const { app, chatId, user } = await createRouteFixture(workdir, [
        'chat-model',
        'preferred-model',
        'request-model',
      ]);
      await updateAppSettings(getDb(), user.id, {
        ...DEFAULT_APP_SETTINGS,
        gitSettings: {
          ...DEFAULT_APP_SETTINGS.gitSettings,
          commitMessage: {
            ...DEFAULT_APP_SETTINGS.gitSettings.commitMessage,
            preferredModel: 'preferred-model',
            systemPrompt: 'Custom commit-message prompt.',
          },
        },
      });

      expect((await generateMessage(app, chatId, 'request-model')).status).toBe(200);
      expect((await generateMessage(app, chatId)).status).toBe(200);
      await updateAppSettings(getDb(), user.id, {
        ...DEFAULT_APP_SETTINGS,
        gitSettings: {
          ...DEFAULT_APP_SETTINGS.gitSettings,
          commitMessage: {
            ...DEFAULT_APP_SETTINGS.gitSettings.commitMessage,
            preferredModel: '',
          },
        },
      });
      expect((await generateMessage(app, chatId)).status).toBe(200);

      expect(capturedRequests.map((request) => request.modelName)).toEqual([
        'request-model',
        'preferred-model',
        'chat-model',
      ]);
      expect(capturedRequests[0]?.systemPrompt).toBe('Custom commit-message prompt.');
    }
  );

  it.skipIf(!hasGit)('returns a typed error for empty model output', async () => {
    installFakeProvider();
    providerOutput = '  \n\n';
    const workdir = await createTempRepo();
    await seedCommit(workdir);
    await writeFile(join(workdir, 'tracked.txt'), 'changed\n');
    const { app, chatId } = await createRouteFixture(workdir);

    const response = await generateMessage(app, chatId);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'GENERATION_EMPTY' });
  });
});
