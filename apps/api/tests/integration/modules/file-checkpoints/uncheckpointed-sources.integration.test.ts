/**
 * What a revert leaves behind, reported end to end.
 *
 * The manifest only covers the builtin mutators, so a turn that also wrote
 * through a shell command or an MCP server has changes on disk that revert
 * cannot touch. These drive real tool calls through the generation layer — the
 * only place that distinction is made — and then assert both halves: the file
 * the manifest covered is restored, and the one it did not is still there,
 * named in the result rather than silently absorbed into the count.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { getDb } from '../../../../src/db/database';
import { listChatFileCheckpointSummaries } from '../../../../src/modules/file-checkpoints/application/list-chat-checkpoints';
import { revertMessageFileCheckpoints } from '../../../../src/modules/file-checkpoints/application/revert-message-checkpoints';
import { executeStandardToolCallsWithProgress } from '../../../../src/modules/generation/application/standard-tool-execution';
import { insertMessage } from '../../../../src/modules/messages/infrastructure/message-repository';
import {
  closeAllMcpClients,
  setMcpClientConnectorForTest,
} from '../../../../src/services/mcp/connection-manager';
import { getRuntimeClient } from '../../../../src/services/runtime-client';
import { isShellAvailable } from '../../../../src/services/tools/builtin/_shell-exec';
import { registerTools } from '../../../../src/services/tools/register-tools';
import type { EffectiveToolSettings } from '../../../../src/services/tools/types';
import {
  type ChatFixture,
  insertTestChat,
  insertTestUser,
  type UserFixture,
} from '../../../support/factories';
import { makeFakeMcpHandle } from '../../../support/fixtures/mcp/fake-handle';

const hasBash = isShellAvailable('bash');
const MCP_TOOL_NAME = 'mcp__uncheckpointed__run';

let tempDir: string;
let chat: ChatFixture;
let messageId: string;

registerTools();

/**
 * One user, and one Local runtime connection, for the whole file.
 *
 * Every test here reaches the filesystem through the Local runtime, and the
 * manager keys connections by `(userId, environmentId)` — so a fresh user per
 * test meant a fresh in-process runtime host per test, plus the single-owner
 * attestation churn of closing and reopening one each time. That churn is real
 * logic, and it is covered directly in the connection-manager unit tests; what
 * it bought here was making every test in the file depend on a connect none of
 * them assert anything about. Connecting once in setup also means a connect
 * that goes wrong fails the file loudly, once, instead of timing out each test
 * in turn with the cause thrown away.
 */
let user: UserFixture;

beforeAll(async () => {
  user = await insertTestUser();
  await getRuntimeClient(user.id);
});

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'uncheckpointed-sources-test-'));
  chat = await insertTestChat(user.id);
  messageId = faker.string.uuid();
  await insertMessage(
    {
      id: messageId,
      chatId: chat.id,
      role: 'ai',
      text: '',
      timestamp: Date.now(),
      isGenerating: false,
      interactionMode: 'chat',
    },
    getDb()
  );
});

afterEach(async () => {
  setMcpClientConnectorForTest(null);
  await closeAllMcpClients();
  // The fixture server is keyed by `(userId, slug)` and the slug is baked into
  // MCP_TOOL_NAME, so it cannot be randomized per test. A fresh user per test
  // used to hide that; with one user for the file, the row has to be cleaned up
  // explicitly or the second install collides.
  await getDb().deleteFrom('mcp_servers').where('userId', '=', chat.userId).execute();
  rmSync(tempDir, { recursive: true, force: true });
});

const SHELL_SETTINGS: EffectiveToolSettings = {
  enabled: true,
  parameters: {
    timeoutSeconds: 10,
    maxOutputBytes: 10_000,
    allowedEnvVars: [],
    deniedEnvVars: [],
  },
};

type ToolCall = [string, { name: string; argsStr: string }];

/** One turn's tool calls, executed the way a streaming turn executes them. */
async function runTurnTools(calls: ReadonlyArray<ToolCall>): Promise<void> {
  for await (const _item of executeStandardToolCallsWithProgress(calls, {
    userId: chat.userId,
    chatId: chat.id,
    environmentId: LOCAL_ENVIRONMENT_ID,
    assistantMessageId: messageId,
    workdir: tempDir,
    db: getDb(),
    settingsByToolName: new Map([['bash', SHELL_SETTINGS]]),
    allowedToolNames: new Set(['bash', 'write_file', MCP_TOOL_NAME]),
  })) {
    // Drained for its effects: the executions themselves are asserted through
    // the filesystem and the manifest below.
  }
}

function writeFileCall(callId: string, path: string, content: string): ToolCall {
  return [callId, { name: 'write_file', argsStr: JSON.stringify({ path, content }) }];
}

function bashCall(callId: string, command: string): ToolCall {
  return [callId, { name: 'bash', argsStr: JSON.stringify({ command, cwd: null }) }];
}

function mcpCall(callId: string): ToolCall {
  return [callId, { name: MCP_TOOL_NAME, argsStr: '{}' }];
}

/** An MCP server the bridge can resolve, answering every call from memory. */
async function installMcpServer(): Promise<void> {
  const now = Date.now();
  await getDb()
    .insertInto('mcp_servers')
    .values({
      id: `uncheckpointed-server-${crypto.randomUUID()}`,
      userId: chat.userId,
      name: 'Uncheckpointed Fixture',
      slug: 'uncheckpointed',
      transport: 'stdio',
      environmentId: LOCAL_ENVIRONMENT_ID,
      command: 'bun',
      argsJson: '[]',
      envJson: '{}',
      url: null,
      enabled: 1,
      timeoutMs: null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  setMcpClientConnectorForTest(() =>
    Promise.resolve(
      makeFakeMcpHandle({
        callTool: () =>
          Promise.resolve({
            contentText: 'ok',
            isError: false,
            rawContentKinds: ['text'],
            content: [{ type: 'text', text: 'ok' }],
          }),
      })
    )
  );
}

function revert() {
  return revertMessageFileCheckpoints(getDb(), chat.id, messageId);
}

async function storedSources(): Promise<string[]> {
  const rows = await getDb()
    .selectFrom('message_uncheckpointed_sources')
    .select('source')
    .where('chatId', '=', chat.id)
    .where('messageId', '=', messageId)
    .execute();
  return rows.map((row) => row.source);
}

describe('revert reporting of writes it never checkpointed', () => {
  it('reports nothing extra for a turn that only ran builtin mutators', async () => {
    const path = join(tempDir, 'only-builtin.txt');
    await runTurnTools([writeFileCall('call-1', path, 'created\n')]);

    const [summary] = await listChatFileCheckpointSummaries(getDb(), chat.id);
    expect(summary?.uncheckpointedSources).toEqual([]);
    // An empty list, not a warning nobody can act on: a notice shown on every
    // revert is one users stop reading before it matters.
    expect(await revert()).toEqual({ revertedFiles: 1, uncheckpointedSources: [] });
    expect(existsSync(path)).toBe(false);
  });

  it.skipIf(!hasBash)('names the shell writes a revert leaves on disk', async () => {
    const checkpointed = join(tempDir, 'checkpointed.txt');
    const shellWritten = join(tempDir, 'shell-written.txt');
    await runTurnTools([
      writeFileCall('call-1', checkpointed, 'from write_file\n'),
      bashCall('call-2', `printf 'from bash\\n' > ${shellWritten}`),
    ]);
    expect(existsSync(shellWritten)).toBe(true);

    const [summary] = await listChatFileCheckpointSummaries(getDb(), chat.id);
    expect(summary?.uncheckpointedSources).toEqual(['shell']);

    expect(await revert()).toEqual({ revertedFiles: 1, uncheckpointedSources: ['shell'] });
    expect(existsSync(checkpointed)).toBe(false);
    // The whole point of the report: this file is still here, and the count
    // above would have claimed the turn was undone.
    expect(existsSync(shellWritten)).toBe(true);
  });

  it('reports MCP tool calls, which the hub cannot prove either way', async () => {
    await installMcpServer();
    const path = join(tempDir, 'checkpointed.txt');
    await runTurnTools([writeFileCall('call-1', path, 'from write_file\n'), mcpCall('call-2')]);

    expect(await revert()).toEqual({ revertedFiles: 1, uncheckpointedSources: ['mcp'] });
  });

  it.skipIf(!hasBash)('reports both sources in a stable order, once each', async () => {
    await installMcpServer();
    const path = join(tempDir, 'checkpointed.txt');
    await runTurnTools([
      writeFileCall('call-1', path, 'from write_file\n'),
      bashCall('call-2', 'true'),
      bashCall('call-3', 'true'),
      mcpCall('call-4'),
      mcpCall('call-5'),
    ]);

    // Two shell calls and two MCP calls, one row each: recording is idempotent,
    // so a chatty turn cannot grow the table without bound.
    expect((await storedSources()).sort()).toEqual(['mcp', 'shell']);
    expect(await revert()).toEqual({
      revertedFiles: 1,
      uncheckpointedSources: ['shell', 'mcp'],
    });
  });

  it.skipIf(!hasBash)('reports the sources of a turn that checkpointed nothing', async () => {
    await runTurnTools([bashCall('call-1', `printf 'x\\n' > ${join(tempDir, 'only-shell.txt')}`)]);

    // No manifest means no revert affordance, so this never reaches the UI —
    // but the API must not answer "nothing happened" when something did.
    expect(await revert()).toEqual({ revertedFiles: 0, uncheckpointedSources: ['shell'] });
    expect(await listChatFileCheckpointSummaries(getDb(), chat.id)).toEqual([]);
  });

  it.skipIf(!hasBash)('records a shell call the tool itself then failed', async () => {
    const path = join(tempDir, 'partial.txt');
    await runTurnTools([
      writeFileCall('call-1', join(tempDir, 'checkpointed.txt'), 'kept\n'),
      // Writes, then exits non-zero. A source recorded only on success would
      // leave exactly this turn claiming a complete revert.
      bashCall('call-2', `printf 'partial\\n' > ${path}; exit 3`),
    ]);

    expect(existsSync(path)).toBe(true);
    expect(await revert()).toEqual({ revertedFiles: 1, uncheckpointedSources: ['shell'] });
  });
});
