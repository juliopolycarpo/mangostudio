/**
 * A subagent's file mutations belong to the turn that delegated them.
 *
 * `executeSubagentTools` hands the parent's `assistantMessageId` down into the
 * subagent's `ToolContext`, which is the only thing keying a delegated write to
 * the manifest the Revert affordance reads. Nothing else asserts it: the type
 * checker is satisfied by a field that is simply never passed, and a row under
 * the subagent's own message id would look like a successful checkpoint while
 * silently removing the write from the parent's revert.
 *
 * So this drives `runSubagentTurn` end to end against a real database, a real
 * temp workdir, real agent profiles and the real tool registry — only the model
 * is a fixture — and asserts the row's **key**, plus that reverting the parent
 * message actually undoes the write.
 *
 * Deliberately no `mock.module`: every test file in a run shares one module
 * graph, and `mock.restore()` does not undo a module mock, so one left behind
 * here rewires unrelated suites later in the same run. The provider is
 * substituted through the registry that production itself uses.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import type { MultiAgentSettings } from '@mangostudio/shared/app-settings';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { getDb } from '../../../../src/db/database';
import {
  getAgentProfile,
  updateAgentProfile,
} from '../../../../src/modules/agents/application/agent-settings-service';
import { revertMessageFileCheckpoints } from '../../../../src/modules/file-checkpoints/application/revert-message-checkpoints';
import { runSubagentTurn } from '../../../../src/modules/generation/application/subagent-runner';
import {
  getProvider,
  registerProvider,
} from '../../../../src/services/providers/core/provider-registry';
import type { AgentEvent, AIProvider } from '../../../../src/services/providers/types';
import { isShellAvailable } from '../../../../src/services/tools/builtin/_shell-exec';
import { registerTools } from '../../../../src/services/tools/register-tools';
import { type ChatFixture, insertTestChat, insertTestUser } from '../../../support/factories';

const hasBash = isShellAvailable('bash');
const MODEL_ID = 'delegated-checkpoints-model';
const PARENT_AGENT_ID = 'default';
const SUBAGENT_ID = 'explore';

type ScriptedCall = { name: string; args: Record<string, unknown> };

let tempDir: string;
let chat: ChatFixture;
let parentMessageId: string;
let scriptedCall: ScriptedCall = { name: 'write_file', args: {} };
let previousProvider: AIProvider | null = null;

registerTools();

/**
 * Emits one tool call, then a summary once its result comes back — the minimum
 * shape `runSubagentStreamLoop` needs to reach `executeSubagentTools` and then
 * terminate.
 */
class ScriptedProvider implements AIProvider {
  readonly providerType = 'openai-compatible' as const;

  generateText(): ReturnType<AIProvider['generateText']> {
    return Promise.resolve({ text: '' });
  }

  listModels(): ReturnType<AIProvider['listModels']> {
    return Promise.resolve([]);
  }

  validateApiKey(): Promise<void> {
    return Promise.resolve();
  }

  resolveApiKey(): Promise<string> {
    return Promise.resolve('test-key');
  }

  async *generateAgentTurnStream(request: { toolResults?: unknown }): AsyncIterable<AgentEvent> {
    await Promise.resolve();
    if (request.toolResults) {
      yield { type: 'assistant_text_delta', text: 'Done.' };
      yield { type: 'turn_completed' };
      return;
    }
    yield { type: 'tool_call_started', callId: 'sub-call-1', name: scriptedCall.name };
    yield {
      type: 'tool_call_completed',
      callId: 'sub-call-1',
      name: scriptedCall.name,
      arguments: JSON.stringify(scriptedCall.args),
    };
    yield { type: 'turn_completed' };
  }
}

const multiAgentSettings: MultiAgentSettings = {
  enabled: true,
  traceVisibility: 'full',
  maxDepth: 2,
  maxSubagentCalls: 5,
  timeoutMs: 30_000,
  defaultMaxTurns: 3,
};

/** The connector row `resolveModel` routes `MODEL_ID` through. */
async function insertConnectorForModel(userId: string): Promise<void> {
  await getDb()
    .insertInto('secret_metadata')
    .values({
      id: `${userId}-delegated-connector`,
      name: 'Delegated Checkpoints Connector',
      provider: 'openai-compatible',
      configured: 1,
      source: 'config-file',
      maskedSuffix: null,
      updatedAt: Date.now(),
      lastValidatedAt: null,
      lastValidationError: null,
      enabledModels: JSON.stringify([MODEL_ID]),
      userId,
      baseUrl: null,
      organizationId: null,
      projectId: null,
    })
    .execute();
}

/** Both built-in agents, stored the way the settings UI stores them. */
async function configureAgents(userId: string, subagentToolNames: string[]): Promise<void> {
  await updateAgentProfile(getDb(), userId, SUBAGENT_ID, {
    name: 'Explore',
    description: '',
    role: 'subagent',
    systemPrompt: 'Do exactly what you are asked.',
    toolNames: subagentToolNames,
    toolsEnabled: true,
    subagentIds: [],
    metadata: {},
  });
  await updateAgentProfile(getDb(), userId, PARENT_AGENT_ID, {
    name: 'Default',
    description: '',
    role: 'both',
    systemPrompt: 'Delegate writes.',
    toolNames: ['delegate_to_agent'],
    toolsEnabled: true,
    subagentIds: [SUBAGENT_ID],
    metadata: {},
  });
}

/** `bash` is opt-in, so a subagent only gets it from a stored user setting. */
async function enableShellForUser(userId: string): Promise<void> {
  const now = Date.now();
  await getDb()
    .insertInto('user_tool_settings')
    .values({
      id: faker.string.uuid(),
      userId,
      toolName: 'bash',
      enabled: 1,
      parametersJson: JSON.stringify({
        timeoutSeconds: 10,
        maxOutputBytes: 10_000,
        allowedEnvVars: [],
        deniedEnvVars: [],
      }),
      createdAt: now,
      updatedAt: now,
    })
    .execute();
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'delegated-checkpoints-test-'));
  try {
    previousProvider = getProvider('openai-compatible');
  } catch {
    previousProvider = null;
  }
  registerProvider(new ScriptedProvider());

  const user = await insertTestUser();
  chat = await insertTestChat(user.id);
  await insertConnectorForModel(user.id);
  parentMessageId = faker.string.uuid();
  await getDb()
    .insertInto('messages')
    .values({
      id: parentMessageId,
      chatId: chat.id,
      role: 'ai',
      text: '',
      imageUrl: null,
      referenceImage: null,
      timestamp: Date.now(),
      isGenerating: 0,
      generationTime: null,
      modelName: null,
      styleParams: null,
      interactionMode: 'chat',
      parts: null,
      providerState: null,
    })
    .execute();
});

afterEach(() => {
  if (previousProvider) registerProvider(previousProvider);
  previousProvider = null;
  rmSync(tempDir, { recursive: true, force: true });
});

async function delegate(call: ScriptedCall, subagentToolNames: string[]) {
  await configureAgents(chat.userId, subagentToolNames);
  scriptedCall = call;
  return await runSubagentTurn({
    db: getDb(),
    userId: chat.userId,
    chatId: chat.id,
    environmentId: LOCAL_ENVIRONMENT_ID,
    assistantMessageId: parentMessageId,
    workdir: tempDir,
    parentAgentProfile: await getAgentProfile(getDb(), chat.userId, PARENT_AGENT_ID),
    parentModelName: MODEL_ID,
    settings: multiAgentSettings,
    request: { agentId: SUBAGENT_ID, task: 'Do the thing.' },
    depth: 0,
  });
}

describe('delegated file mutations', () => {
  it('checkpoints a subagent write against the delegating message, and reverts it', async () => {
    const path = join(tempDir, 'written-by-subagent.txt');
    const result = await delegate(
      { name: 'write_file', args: { path, content: 'from the subagent\n' } },
      ['write_file']
    );

    expect(result.status).toBe('completed');
    expect(await Bun.file(path).text()).toBe('from the subagent\n');

    const rows = await getDb()
      .selectFrom('file_checkpoints')
      .selectAll()
      .where('chatId', '=', chat.id)
      .execute();

    // The assertion that matters. A row keyed on the subagent's own message id
    // would still be a checkpoint — just not one the parent's revert can see.
    expect(rows.map((row) => row.messageId)).toEqual([parentMessageId]);
    expect(rows[0]?.op).toBe('create');
    expect(rows[0]?.path).toBe(path);

    expect(await revertMessageFileCheckpoints(getDb(), chat.id, parentMessageId)).toEqual({
      revertedFiles: 1,
      uncheckpointedSources: [],
    });
    expect(existsSync(path)).toBe(false);
  });

  it.skipIf(!hasBash)(
    'reports a subagent shell command against the delegating message',
    async () => {
      await enableShellForUser(chat.userId);
      const path = join(tempDir, 'written-by-subagent-shell.txt');
      const result = await delegate(
        { name: 'bash', args: { command: `printf 'from the subagent\\n' > ${path}`, cwd: null } },
        ['bash']
      );

      expect(result.status).toBe('completed');
      expect(existsSync(path)).toBe(true);

      // Delegation does not launder an unsnapshotted write into a clean revert:
      // the parent turn owns what it delegated, uncovered writes included.
      expect(await revertMessageFileCheckpoints(getDb(), chat.id, parentMessageId)).toEqual({
        revertedFiles: 0,
        uncheckpointedSources: ['shell'],
      });
      expect(existsSync(path)).toBe(true);
    }
  );
});
