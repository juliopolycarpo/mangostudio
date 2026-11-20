/**
 * A user's retry of a shell call goes through the same workspace checkpoint
 * path a model turn does.
 *
 * The retry builds its own tool runtime (`resolveTurnToolRuntime`) instead of
 * sharing the turn's, so a regression there would silently run the command
 * with the checkpoint option dropped: the retry's writes would reach disk with
 * no revertible row. These run a real bash call against a real git repository
 * through `reserveToolCallRetry` and `runToolCallRetry`, with the tool setting
 * saved the way the settings page saves it, then revert the message and read
 * the disk back.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isShellAvailable } from '@mangostudio/shared/process/host';
import type { MessagePart } from '@mangostudio/shared/types';

import { getDb } from '../../../../src/db/database';
import { revertMessageFileCheckpoints } from '../../../../src/modules/file-checkpoints/application/revert-message-checkpoints';
import {
  reserveToolCallRetry,
  runToolCallRetry,
} from '../../../../src/modules/generation/application/tool-call-retry';
import { createTurnCheckpointPart } from '../../../../src/modules/generation/application/turn-checkpoint';
import { insertMessage } from '../../../../src/modules/messages/infrastructure/message-repository';
import { upsertToolSettings } from '../../../../src/modules/tool-settings/infrastructure/tool-settings-repository';
import { registerTools } from '../../../../src/services/tools/register-tools';
import { type ChatFixture, insertTestChat, type UserFixture } from '../../../support/factories';
import { insertUserWithLocalRuntime } from '../../../support/fixtures/local-runtime-user';
import { gitFixtureEnv } from '../../../support/git-fixture-env';
import { removeFixtureDirSync } from '../../../support/remove-fixture-dir';

const hasBash = isShellAvailable('bash');
const hasGit = Bun.which('git') !== null;
const runnable = hasBash && hasGit;

const SHELL_COMMAND = "printf 'from retry\\n' > a.txt";

let workdir: string;
let chat: ChatFixture;
let user: UserFixture;
let messageId: string;

registerTools();

beforeAll(async () => {
  user = await insertUserWithLocalRuntime();
});

beforeEach(async () => {
  workdir = mkdtempSync(join(tmpdir(), 'shell-retry-checkpoints-'));
  chat = await insertTestChat(user.id);
  await getDb().updateTable('chats').set({ workdir }).where('id', '=', chat.id).execute();
});

afterEach(() => {
  removeFixtureDirSync({ role: 'shell-retry-checkpoints', path: workdir });
});

function git(...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd: workdir, env: gitFixtureEnv() });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed in ${workdir}: expected exit 0 | received ${result.exitCode}: ${result.stderr.toString()}`
    );
  }
}

function initRepository(files: Record<string, string>): void {
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  git('config', 'commit.gpgsign', 'false');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(workdir, name, '..'), { recursive: true });
    writeFileSync(join(workdir, name), content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
}

async function saveShellSettings(checkpointWorkspaceWrites: boolean): Promise<void> {
  await upsertToolSettings(getDb(), user.id, 'bash', {
    enabled: true,
    parameters: {
      timeoutSeconds: 30,
      maxOutputBytes: 10_000,
      allowedEnvVars: [],
      deniedEnvVars: [],
      checkpointWorkspaceWrites,
    },
  });
}

/** An assistant message whose only shell call timed out, so it offers a retry. */
async function seedTimedOutShellCall(): Promise<void> {
  messageId = crypto.randomUUID();
  const checkpoint = {
    ...createTurnCheckpointPart({
      turnId: messageId,
      startedAt: Date.now(),
      provider: 'openai',
      modelName: 'gpt-test',
      agentId: 'default',
    }),
    status: 'completed' as const,
  };
  const parts: MessagePart[] = [
    checkpoint,
    { type: 'text', text: 'I ran the command.' },
    {
      type: 'tool_call',
      toolCallId: 'call-1',
      name: 'bash',
      args: { command: SHELL_COMMAND, cwd: null },
      execution: {
        source: 'builtin',
        queuedAt: 1,
        startedAt: 2,
        finishedAt: 3,
        status: 'timed_out',
        reasonCode: 'timeout',
      },
    },
    {
      type: 'tool_result',
      toolCallId: 'call-1',
      content: JSON.stringify({ error: 'Command timed out after 30 seconds.' }),
      isError: true,
    },
  ];
  await insertMessage(
    {
      id: messageId,
      chatId: chat.id,
      role: 'ai',
      text: 'I ran the command.',
      timestamp: Date.now(),
      isGenerating: false,
      generationTime: '1.5s',
      modelName: 'gpt-test',
      interactionMode: 'agent',
      parts: JSON.stringify(parts),
    },
    getDb()
  );
}

/** Retries the seeded call to completion and returns the events it streamed. */
async function retryShellCall() {
  const reserved = await reserveToolCallRetry(
    {
      chatId: chat.id,
      messageId,
      callId: 'call-1',
      userId: user.id,
      confirmed: true,
      onTurnReserved: () => {},
    },
    getDb()
  );
  const events = [];
  for await (const event of runToolCallRetry(reserved, getDb(), new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

describe.skipIf(!runnable)('shell retry workspace checkpoints', () => {
  it('snapshots the workspace around a retried shell call when the option is on', async () => {
    initRepository({ 'a.txt': 'a-original\n' });
    await saveShellSettings(true);
    await seedTimedOutShellCall();

    const events = await retryShellCall();

    expect(events.at(-1)).toMatchObject({ type: 'done', messageId });
    expect(readFileSync(join(workdir, 'a.txt'), 'utf8')).toBe('from retry\n');
    expect(await revertMessageFileCheckpoints(getDb(), chat.id, messageId)).toEqual({
      revertedFiles: 1,
      uncheckpointedSources: [],
    });
    expect(readFileSync(join(workdir, 'a.txt'), 'utf8')).toBe('a-original\n');
    expect(existsSync(join(workdir, 'a.txt'))).toBe(true);
  });

  it('discloses the unrecorded write of a retried shell call when the option is off', async () => {
    initRepository({ 'a.txt': 'a-original\n' });
    await saveShellSettings(false);
    await seedTimedOutShellCall();

    await retryShellCall();

    expect(await revertMessageFileCheckpoints(getDb(), chat.id, messageId)).toEqual({
      revertedFiles: 0,
      uncheckpointedSources: ['shell'],
    });
    expect(readFileSync(join(workdir, 'a.txt'), 'utf8')).toBe('from retry\n');
  });
});
