import { mock } from 'bun:test';
import type { AgentProfile } from '@mangostudio/shared/agents';
import type { ProviderType } from '@mangostudio/shared/types';
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
import {
  insertMessage,
  listLegacyGalleryImages,
  listByChatId as listMessagesByChatId,
  loadHistory,
  loadRichHistory,
  updateMessage,
  verifyMessageOwnership,
} from '../../../src/modules/messages/infrastructure/message-repository';
import * as realProviderSettingsRepoNs from '../../../src/modules/provider-settings/infrastructure/provider-settings-repository';
import * as realToolSettingsRepoNs from '../../../src/modules/tool-settings/infrastructure/tool-settings-repository';
import * as realGeminiNs from '../../../src/services/gemini';
import {
  getProvider,
  getProviderForModel,
  registerProvider,
} from '../../../src/services/providers/core/provider-registry';
import type { AgentTurnRequest } from '../../../src/services/providers/types';
import {
  executeTool,
  getAllToolDefinitions,
  getAllTools,
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
export const realGetAllTools = getAllTools;
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
export const realInsertMessage = insertMessage;
export const realUpdateMessage = updateMessage;
export const realListMessagesByChatId = listMessagesByChatId;
export const realLoadHistory = loadHistory;
export const realLoadRichHistory = loadRichHistory;
export const realVerifyMessageOwnership = verifyMessageOwnership;
export const realListLegacyGalleryImages = listLegacyGalleryImages;

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
    getAllTools: realGetAllTools,
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
  await mock.module('../../../src/modules/messages/infrastructure/message-repository', () => ({
    insertMessage: realInsertMessage,
    updateMessage: realUpdateMessage,
    listByChatId: realListMessagesByChatId,
    loadHistory: realLoadHistory,
    loadRichHistory: realLoadRichHistory,
    verifyMessageOwnership: realVerifyMessageOwnership,
    listLegacyGalleryImages: realListLegacyGalleryImages,
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

export interface CapturedDbMock {
  insertedMessages: Array<Record<string, unknown>>;
  chatSetCalls: Array<Record<string, unknown>>;
  moduleFactory: () => { getDb: () => Record<string, unknown> };
}

export interface TestStreamDbOptions {
  userId: string;
  insertedMessages?: Array<Record<string, unknown>>;
  chatSetCalls?: Array<Record<string, unknown>>;
  selectFrom?: (table: string) => Record<string, unknown>;
  onInsert?: (table: string, values: Record<string, unknown>) => void;
}

export type AgentStreamFactory = (req: AgentTurnRequest) => AsyncIterable<Record<string, unknown>>;

export interface ProviderRegistryMockOptions {
  providerType?: ProviderType;
  generateImage?: (request: Record<string, unknown>) => Promise<{ imageUrl: string }>;
}

export interface SubagentProfileMockOptions {
  subagentOverrides?: Partial<AgentProfile>;
  parentOverrides?: Partial<AgentProfile>;
}

export interface MultiAgentSettingsOverrides {
  enabled?: boolean;
  chatDelegationEnabled?: boolean;
  traceVisibility?: 'off' | 'summary' | 'full';
  maxDepth?: number;
  maxSubagentCalls?: number;
  timeoutMs?: number;
  defaultMaxTurns?: number;
}

/**
 * Builds a standard POST request for the streaming route.
 * // Usage: app.handle(buildRespondStreamRequest({ chatId: 'c1', prompt: 'Hi' }))
 */
export function buildRespondStreamRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/respond/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Mocks chat ownership as verified for streaming route authorization.
 * // Usage: await mockVerifiedChatOwnership()
 */
export async function mockVerifiedChatOwnership(): Promise<void> {
  await mock.module('../../../src/modules/chats/infrastructure/chat-repository', () => ({
    verifyChatOwnership: () => Promise.resolve(true),
  }));
}

/**
 * Mocks the database with no-op writes and a successful chat ownership row.
 * // Usage: await mock.module('../../../src/db/database', mockPassThroughDb(userId))
 */
export function mockPassThroughDb(userId: string): () => { getDb: () => Record<string, unknown> } {
  return () => ({
    getDb: () => createCapturedDb(userId, [], []),
  });
}

/** Builds a transactional stream DB mock that applies assistant-row updates. */
export function createTestStreamDb(options: TestStreamDbOptions): Record<string, unknown> {
  const insertedMessages = options.insertedMessages ?? [];
  const chatSetCalls = options.chatSetCalls ?? [];
  const db: Record<string, unknown> = {
    selectFrom: options.selectFrom ?? (() => makeChain({ userId: options.userId })),
    insertInto: (table: string) => createInsertCapture(table, insertedMessages, options.onInsert),
    updateTable: (table: string) => createUpdateCapture(table, insertedMessages, chatSetCalls),
  };
  db.transaction = () => ({
    execute: (callback: (trx: Record<string, unknown>) => unknown) => callback(db),
  });
  return db;
}

/**
 * Mocks the database and captures inserted message rows.
 * // Usage: const db = mockDbWithMessageCapture(userId)
 */
export function mockDbWithMessageCapture(userId: string): CapturedDbMock {
  const insertedMessages: Array<Record<string, unknown>> = [];
  const chatSetCalls: Array<Record<string, unknown>> = [];

  return createCapturedDbMock(userId, insertedMessages, chatSetCalls);
}

/**
 * Mocks the database and captures inserted messages plus chat update payloads.
 * // Usage: const db = mockDbWithFullCapture(userId)
 */
export function mockDbWithFullCapture(userId: string): CapturedDbMock {
  return mockDbWithMessageCapture(userId);
}

/**
 * Mocks a provider registry entry backed by a named agent stream factory.
 * // Usage: await mockProviderRegistry(async function* stream(req) { ... })
 */
export async function mockProviderRegistry(
  streamFactory: AgentStreamFactory,
  options: ProviderRegistryMockOptions = {}
): Promise<void> {
  await mock.module('../../../src/services/providers/core/provider-registry', () => ({
    getProviderForModel: () => Promise.resolve(createProviderMock(streamFactory, options)),
  }));
}

/**
 * Mocks the tools service with empty definitions and no-op execution.
 * // Usage: await mockNoopTools()
 */
export async function mockNoopTools(): Promise<void> {
  await mock.module('../../../src/services/tools', () => ({
    getAllToolDefinitions: () => [],
    getToolDefinitionsForAgent: () => [],
    executeTool: () => Promise.resolve({}),
  }));
}

/**
 * Mocks default parent/subagent profiles used by delegation tests.
 * // Usage: await mockSubagentAgentSettings({ subagentOverrides: { toolsEnabled: true } })
 */
export async function mockSubagentAgentSettings(
  options: SubagentProfileMockOptions = {}
): Promise<void> {
  await mock.module('../../../src/modules/agents/application/agent-settings-service', () => ({
    getAgentProfile: (_db: unknown, _userId: string, agentId: string) =>
      Promise.resolve(resolveSubagentProfile(agentId, options)),
  }));
}

/**
 * Mocks multi-agent app settings with production-like defaults.
 * // Usage: await mockMultiAgentAppSettings({ timeoutMs: 25 })
 */
export async function mockMultiAgentAppSettings(
  overrides: MultiAgentSettingsOverrides = {}
): Promise<void> {
  await mock.module('../../../src/modules/app-settings/application/app-settings-service', () => ({
    getAppSettings: () => Promise.resolve({ multiAgentSettings: multiAgentSettings(overrides) }),
  }));
}

/**
 * Returns the delegation error class expected by subagent-runner mocks.
 * // Usage: SubagentDelegationError: createSubagentDelegationError()
 */
export function createSubagentDelegationError(): typeof realSubagentDelegationError {
  return class SubagentDelegationError extends Error {
    constructor(
      message: string,
      readonly code: string
    ) {
      super(message);
      this.name = 'SubagentDelegationError';
    }
  } as typeof realSubagentDelegationError;
}

function createCapturedDbMock(
  userId: string,
  insertedMessages: Array<Record<string, unknown>>,
  chatSetCalls: Array<Record<string, unknown>>
): CapturedDbMock {
  return {
    insertedMessages,
    chatSetCalls,
    moduleFactory: () => ({
      getDb: () => createCapturedDb(userId, insertedMessages, chatSetCalls),
    }),
  };
}

function createCapturedDb(
  userId: string,
  insertedMessages: Array<Record<string, unknown>>,
  chatSetCalls: Array<Record<string, unknown>>
): Record<string, unknown> {
  return createTestStreamDb({
    userId,
    insertedMessages,
    chatSetCalls,
  });
}

function createInsertCapture(
  table: string,
  insertedMessages: Array<Record<string, unknown>>,
  onInsert?: (table: string, values: Record<string, unknown>) => void
): Record<string, unknown> {
  return {
    values: (values: Record<string, unknown>) => {
      if (table === 'messages') insertedMessages.push({ ...values });
      onInsert?.(table, values);
      return { execute: () => Promise.resolve() };
    },
  };
}

function createUpdateCapture(
  table: string,
  insertedMessages: Array<Record<string, unknown>>,
  chatSetCalls: Array<Record<string, unknown>>
): Record<string, unknown> {
  let updateValues: Record<string, unknown> = {};
  const conditions: Array<{ field: string; value: unknown }> = [];
  const applyUpdate = (): boolean => {
    if (table !== 'messages') return true;
    const message = insertedMessages.find((row) =>
      conditions.every(({ field, value }) => valuesMatch(row[field], value))
    );
    if (!message) return false;
    Object.assign(message, updateValues);
    return true;
  };
  const chain: Record<string, unknown> = {
    where: (field: string, _operator: string, value: unknown) => {
      conditions.push({ field, value });
      return chain;
    },
    execute: () => {
      applyUpdate();
      return Promise.resolve([]);
    },
    executeTakeFirst: () => Promise.resolve({ numUpdatedRows: applyUpdate() ? 1n : 0n }),
  };
  return {
    set: (values: Record<string, unknown>) => {
      updateValues = { ...values };
      if (table === 'chats') chatSetCalls.push({ ...values });
      return chain;
    },
  };
}

function valuesMatch(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'boolean' && typeof expected === 'number') {
    return Number(actual) === expected;
  }
  return actual === expected;
}

function createProviderMock(
  streamFactory: AgentStreamFactory,
  options: ProviderRegistryMockOptions
): Record<string, unknown> {
  return {
    providerType: options.providerType ?? 'openai-compatible',
    generateText: () => Promise.resolve({ text: '' }),
    generateAgentTurnStream: streamFactory,
    ...(options.generateImage ? { generateImage: options.generateImage } : {}),
  };
}

function resolveSubagentProfile(
  agentId: string,
  options: SubagentProfileMockOptions
): AgentProfile {
  if (agentId === 'user:explorer') return explorerProfile(options.subagentOverrides);
  return parentProfile(options.parentOverrides);
}

function explorerProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return makeAgentProfile({
    id: 'user:explorer',
    name: 'Explore',
    role: 'subagent',
    systemPrompt: 'Explore the codebase.',
    toolNames: [],
    toolsEnabled: false,
    ...overrides,
  });
}

function parentProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return makeAgentProfile({
    id: 'default',
    name: 'Default',
    role: 'both',
    systemPrompt: 'Delegate exploration when useful.',
    toolNames: ['delegate_to_agent'],
    toolsEnabled: true,
    subagentIds: ['user:explorer'],
    ...overrides,
  });
}

function multiAgentSettings(
  overrides: MultiAgentSettingsOverrides
): Required<MultiAgentSettingsOverrides> {
  return {
    enabled: true,
    chatDelegationEnabled: true,
    traceVisibility: 'full',
    maxDepth: 2,
    maxSubagentCalls: 5,
    timeoutMs: 5_000,
    defaultMaxTurns: 2,
    ...overrides,
  };
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
