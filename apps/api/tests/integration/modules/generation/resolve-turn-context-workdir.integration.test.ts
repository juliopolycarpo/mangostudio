/**
 * resolveTurnContext reading the chat row: the workdir it stores reaches
 * TurnContext as both a policy and a prompt section, so prompts and
 * filesystem tools agree; the runner it stores names the agent that runs the
 * turn when the request does not.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../../../../src/db/database';
import { loadConfigForTest } from '../../../../src/lib/config';
import { updateAgentProfile } from '../../../../src/modules/agents/application/agent-settings-service';
import { resolveTurnContext } from '../../../../src/modules/generation/application/resolve-turn-context';
import {
  resetSkillsCache,
  setThirdPartySkillDirsForTest,
} from '../../../../src/modules/skills/application/skill-discovery';
import { WORKDIR_RESTRICTED_PROMPT_LINE } from '../../../../src/modules/workspaces/application/workdir-prompt-section';
import {
  getProvider,
  registerProvider,
} from '../../../../src/services/providers/core/provider-registry';
import type { AgentEvent, AIProvider } from '../../../../src/services/providers/types';
import { insertTestChat, insertTestUser, type UserFixture } from '../../../support/factories';

const MODEL_ID = 'workdir-scope-model';

class NoopProvider implements AIProvider {
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

  async *generateAgentTurnStream(): AsyncIterable<AgentEvent> {
    await Promise.resolve();
    yield { type: 'turn_completed' };
  }
}

let user: UserFixture;
let chatId: string;
let boundWorkdir: string;
let agentsDir: string;
let previousProvider: AIProvider | null = null;

async function insertConnectorForModel(): Promise<void> {
  await getDb()
    .insertInto('secret_metadata')
    .values({
      id: `${user.id}-workdir-scope-connector`,
      name: 'Workdir scope connector',
      provider: 'openai-compatible',
      configured: 1,
      source: 'config-file',
      maskedSuffix: null,
      updatedAt: Date.now(),
      lastValidatedAt: null,
      lastValidationError: null,
      enabledModels: JSON.stringify([MODEL_ID]),
      userId: user.id,
      baseUrl: null,
      organizationId: null,
      projectId: null,
    })
    .execute();
}

async function allowAllToolsForDefaultAgent(): Promise<void> {
  await updateAgentProfile(getDb(), user.id, 'default', {
    name: 'Default',
    description: '',
    role: 'both',
    systemPrompt: '',
    toolNames: ['*'],
    toolsEnabled: true,
    subagentIds: [],
    metadata: {},
  });
}

beforeEach(async () => {
  agentsDir = mkdtempSync(join(tmpdir(), 'mango-workdir-scope-agents-'));
  boundWorkdir = mkdtempSync(join(tmpdir(), 'mango-bound-workdir-'));
  loadConfigForTest({
    auth: { secret: 'test-secret-at-least-32-characters-long', url: 'http://localhost:3001' },
    database: { path: ':memory:' },
    skills: { dir: mkdtempSync(join(tmpdir(), 'mango-workdir-scope-skills-')) },
  });
  setThirdPartySkillDirsForTest({ agents: agentsDir });
  resetSkillsCache();

  user = await insertTestUser();
  const chat = await insertTestChat(user.id);
  chatId = chat.id;
  await getDb()
    .updateTable('chats')
    .set({ workdir: boundWorkdir, restrictToolsToWorkdir: 1 })
    .where('id', '=', chatId)
    .execute();
  await insertConnectorForModel();
  await allowAllToolsForDefaultAgent();

  try {
    previousProvider = getProvider('openai-compatible');
  } catch {
    previousProvider = null;
  }
  registerProvider(new NoopProvider());
});

afterEach(() => {
  if (previousProvider) registerProvider(previousProvider);
  previousProvider = null;
  setThirdPartySkillDirsForTest(null);
  resetSkillsCache();
  rmSync(agentsDir, { recursive: true, force: true });
  rmSync(boundWorkdir, { recursive: true, force: true });
});

describe('resolveTurnContext workdir scope', () => {
  it('populates workdir, policy, and prompt section when the chat row is bound', async () => {
    const context = await resolveTurnContext(
      { chatId, userId: user.id, prompt: 'Hello', model: MODEL_ID },
      getDb()
    );

    expect(context.workdir).toBe(boundWorkdir);
    expect(context.workdirPolicy).toEqual({ root: boundWorkdir, restricted: true });
    expect(context.effectiveSystemPrompt).toContain(`Working directory:\n${boundWorkdir}`);
    expect(context.effectiveSystemPrompt).toContain(WORKDIR_RESTRICTED_PROMPT_LINE);
  });
});

describe('resolveTurnContext agent resolution', () => {
  it('runs the persisted runner agent when the request names none', async () => {
    await getDb()
      .updateTable('chats')
      .set({ runnerAgentId: 'explore' })
      .where('id', '=', chatId)
      .execute();

    const context = await resolveTurnContext(
      { chatId, userId: user.id, prompt: 'Hello', model: MODEL_ID },
      getDb()
    );

    expect(context.agentRuntime.profile.id).toBe('explore');
  });

  it('lets an explicit request agent override the persisted runner', async () => {
    await getDb()
      .updateTable('chats')
      .set({ runnerAgentId: 'explore' })
      .where('id', '=', chatId)
      .execute();

    const context = await resolveTurnContext(
      { chatId, userId: user.id, prompt: 'Hello', model: MODEL_ID, agentId: 'default' },
      getDb()
    );

    expect(context.agentRuntime.profile.id).toBe('default');
  });
});
