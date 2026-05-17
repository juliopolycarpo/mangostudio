import { mock } from 'bun:test';
import type { AgentProfile } from '@mangostudio/shared/agents';
import { getDb } from '../../../src/db/database';
import { getAgentProfile } from '../../../src/modules/agents/application/agent-settings-service';
import { AgentSettingsError } from '../../../src/modules/agents/domain/agent-profile';
import { getAppSettings } from '../../../src/modules/app-settings/application/app-settings-service';
import {
  createChat,
  deleteChat,
  getById,
  listByUserId,
  updateChat,
  verifyChatOwnership,
} from '../../../src/modules/chats/infrastructure/chat-repository';
import { clearSubagentCache } from '../../../src/modules/generation/application/subagent-response-cache';
import {
  runSubagentTurn,
  SubagentDelegationError,
} from '../../../src/modules/generation/application/subagent-runner';
import * as realProviderSettingsRepoNs from '../../../src/modules/provider-settings/infrastructure/provider-settings-repository';
import * as realToolSettingsRepoNs from '../../../src/modules/tool-settings/infrastructure/tool-settings-repository';
import * as realGeminiNs from '../../../src/services/gemini';
import {
  getProvider,
  getProviderForModel,
  registerProvider,
} from '../../../src/services/providers/core/provider-registry';
import {
  executeTool,
  getAllToolDefinitions,
  getSafeEffectiveToolSettings,
  getTool,
  getToolDefinitionsForAgent,
} from '../../../src/services/tools';

// Snapshot real implementations at module-load time, before any test can call
// mock.module(). Bun's mock.module() updates live namespace bindings, so
// spreading a namespace object in afterEach would spread already-mocked values.
// Capturing individual named exports as constants avoids that trap.
export const realGetDb = getDb;
export const realVerifyChatOwnership = verifyChatOwnership;
export const realListByUserId = listByUserId;
export const realGetById = getById;
export const realCreateChat = createChat;
export const realUpdateChat = updateChat;
export const realDeleteChat = deleteChat;
export const realGetProviderForModel = getProviderForModel;
export const realGetProvider = getProvider;
export const realRegisterProvider = registerProvider;
export const realGetAllToolDefinitions = getAllToolDefinitions;
export const realGetToolDefinitionsForAgent = getToolDefinitionsForAgent;
export const realExecuteTool = executeTool;
export const realGetTool = getTool;
export const realGetSafeEffectiveToolSettings = getSafeEffectiveToolSettings;
export const realGetAgentProfile = getAgentProfile;
export const realGetAppSettings = getAppSettings;
export const realRunSubagentTurn = runSubagentTurn;
export const realSubagentDelegationError = SubagentDelegationError;
export const realGemini = { ...realGeminiNs };
export const realProviderSettingsRepo = { ...realProviderSettingsRepoNs };
export const realToolSettingsRepo = { ...realToolSettingsRepoNs };

export { AgentSettingsError };

export async function restoreAllMocks(): Promise<void> {
  clearSubagentCache();
  await mock.module('../../../src/db/database', () => ({ getDb: realGetDb }));
  await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
    verifyChatOwnership: realVerifyChatOwnership,
    listByUserId: realListByUserId,
    getById: realGetById,
    createChat: realCreateChat,
    updateChat: realUpdateChat,
    deleteChat: realDeleteChat,
  }));
  await mock.module('../../../src/services/providers/core/provider-registry', () => ({
    getProviderForModel: realGetProviderForModel,
    getProvider: realGetProvider,
    registerProvider: realRegisterProvider,
  }));
  await mock.module('../../../src/services/tools', () => ({
    getAllToolDefinitions: realGetAllToolDefinitions,
    getToolDefinitionsForAgent: realGetToolDefinitionsForAgent,
    executeTool: realExecuteTool,
    getTool: realGetTool,
    getSafeEffectiveToolSettings: realGetSafeEffectiveToolSettings,
  }));
  await mock.module('../../../src/modules/app-settings/application/app-settings-service', () => ({
    getAppSettings: realGetAppSettings,
  }));
  await mock.module('../../../src/services/gemini', () => realGemini);
  await mock.module(
    '../../../src/modules/provider-settings/infrastructure/provider-settings-repository',
    () => realProviderSettingsRepo
  );
  await mock.module(
    '../../../src/modules/tool-settings/infrastructure/tool-settings-repository',
    () => realToolSettingsRepo
  );
  await mock.module('../../../src/modules/agents/application/agent-settings-service', () => ({
    getAgentProfile: realGetAgentProfile,
  }));
  await mock.module('../../../src/modules/generation/application/subagent-runner', () => ({
    runSubagentTurn: realRunSubagentTurn,
    SubagentDelegationError: realSubagentDelegationError,
  }));
}

/**
 * Creates a fully chainable Kysely-mock using a Proxy.
 * - executeTakeFirst() → firstValue  (ownership checks, single-row lookups)
 * - execute()          → []          (list queries like loadHistory)
 */
export function makeChain(firstValue: unknown): Record<string, unknown> {
  const terminal = {
    execute: () => Promise.resolve([]),
    executeTakeFirst: () => Promise.resolve(firstValue),
  };
  const proxy: Record<string, unknown> = new Proxy(terminal, {
    get(target, prop) {
      if (prop in target) return (target as Record<string, unknown>)[prop as string];
      return () => proxy;
    },
  });
  return proxy;
}

export function parseSseEvents(rawText: string): Array<Record<string, unknown>> {
  return rawText
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => {
      try {
        return JSON.parse(block.replace(/^data: /, '')) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((event): event is Record<string, unknown> => event !== null);
}

export function parsePersistedParts(value: unknown): Array<Record<string, unknown>> {
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed) as Array<Record<string, unknown>>;
}

export function parsePersistedRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  return JSON.parse(trimmed) as Record<string, unknown>;
}

export function makeAgentProfile(overrides: Partial<AgentProfile>): AgentProfile {
  return {
    id: 'default',
    name: 'Default',
    description: '',
    kind: 'builtin',
    role: 'both',
    source: { type: 'builtin' },
    systemPrompt: 'Default agent prompt.',
    toolNames: [],
    toolsEnabled: false,
    subagentIds: [],
    metadata: {},
    ...overrides,
  };
}
