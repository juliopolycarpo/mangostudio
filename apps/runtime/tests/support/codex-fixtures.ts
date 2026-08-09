/**
 * Fixture factories built from the **vendored Codex contract**, not from hand-
 * written JSON.
 *
 * Every builder's return type is one of the generated types under
 * `src/services/external-agents/codex/protocol`, so a scenario composed from
 * these is type-checked against the vendor's own shapes. When
 * `bun run vendor:codex-protocol` pulls in a version that renames or retypes a
 * field, the build breaks here — loudly, at the point the assumption lives —
 * instead of a stale literal continuing to satisfy a test that no longer
 * describes the protocol.
 *
 * Real captures pin *ordering*; these pin *shape*. Both are needed, and neither
 * substitutes for the other.
 */

import type { AgentMessageDeltaNotification } from '../../src/services/external-agents/codex/protocol/v2/AgentMessageDeltaNotification';
import type { CommandExecutionRequestApprovalParams } from '../../src/services/external-agents/codex/protocol/v2/CommandExecutionRequestApprovalParams';
import type { ErrorNotification } from '../../src/services/external-agents/codex/protocol/v2/ErrorNotification';
import type { FileChangeRequestApprovalParams } from '../../src/services/external-agents/codex/protocol/v2/FileChangeRequestApprovalParams';
import type { ItemCompletedNotification } from '../../src/services/external-agents/codex/protocol/v2/ItemCompletedNotification';
import type { ItemStartedNotification } from '../../src/services/external-agents/codex/protocol/v2/ItemStartedNotification';
import type { Model } from '../../src/services/external-agents/codex/protocol/v2/Model';
import type { PermissionProfileSummary } from '../../src/services/external-agents/codex/protocol/v2/PermissionProfileSummary';
import type { ReasoningSummaryTextDeltaNotification } from '../../src/services/external-agents/codex/protocol/v2/ReasoningSummaryTextDeltaNotification';
import type { Thread } from '../../src/services/external-agents/codex/protocol/v2/Thread';
import type { ThreadItem } from '../../src/services/external-agents/codex/protocol/v2/ThreadItem';
import type { ThreadStartResponse } from '../../src/services/external-agents/codex/protocol/v2/ThreadStartResponse';
import type { ThreadTokenUsageUpdatedNotification } from '../../src/services/external-agents/codex/protocol/v2/ThreadTokenUsageUpdatedNotification';
import type { Turn } from '../../src/services/external-agents/codex/protocol/v2/Turn';
import type { TurnCompletedNotification } from '../../src/services/external-agents/codex/protocol/v2/TurnCompletedNotification';
import type { TurnStartResponse } from '../../src/services/external-agents/codex/protocol/v2/TurnStartResponse';

export const THREAD_ID = '019fe6d2-d17d-7420-b12c-3c5117cf3de5';
export const TURN_ID = '019fe6d2-e0fc-73f2-a1ee-3a190d09293b';

export function agentMessageItem(id: string, text: string): ThreadItem {
  return { type: 'agentMessage', id, text, phase: null, memoryCitation: null };
}

export function reasoningItem(id: string, summary: readonly string[]): ThreadItem {
  return { type: 'reasoning', id, summary: [...summary], content: [] };
}

export function userMessageItem(id: string, text: string): ThreadItem {
  return {
    type: 'userMessage',
    id,
    clientId: null,
    content: [{ type: 'text', text, text_elements: [] }],
  };
}

export function commandExecutionItem(
  id: string,
  command: string,
  status: 'inProgress' | 'completed' | 'failed' | 'declined' = 'completed'
): ThreadItem {
  return {
    type: 'commandExecution',
    id,
    pluginId: null,
    scriptPath: null,
    command,
    cwd: '/workspace',
    processId: null,
    source: 'agent',
    status,
    commandActions: [],
    aggregatedOutput: null,
    exitCode: status === 'completed' ? 0 : 1,
    durationMs: 12,
  };
}

export function fileChangeItem(
  id: string,
  paths: readonly string[],
  status: 'inProgress' | 'completed' | 'failed' | 'declined' = 'completed'
): ThreadItem {
  return {
    type: 'fileChange',
    id,
    changes: paths.map((path) => ({ path, kind: { type: 'update', move_path: null }, diff: '' })),
    status,
  };
}

export function itemStarted(item: ThreadItem, turnId = TURN_ID): ItemStartedNotification {
  return { item, threadId: THREAD_ID, turnId, startedAtMs: 1_000 };
}

export function itemCompleted(item: ThreadItem, turnId = TURN_ID): ItemCompletedNotification {
  return { item, threadId: THREAD_ID, turnId, completedAtMs: 2_000 };
}

export function agentMessageDelta(
  itemId: string,
  delta: string,
  turnId = TURN_ID
): AgentMessageDeltaNotification {
  return { threadId: THREAD_ID, turnId, itemId, delta };
}

export function reasoningSummaryDelta(
  itemId: string,
  delta: string,
  turnId = TURN_ID
): ReasoningSummaryTextDeltaNotification {
  return { threadId: THREAD_ID, turnId, itemId, delta, summaryIndex: 0 };
}

export function tokenUsageUpdated(turnId = TURN_ID): ThreadTokenUsageUpdatedNotification {
  return {
    threadId: THREAD_ID,
    turnId,
    tokenUsage: {
      total: {
        totalTokens: 21_431,
        inputTokens: 21_424,
        cachedInputTokens: 6_912,
        cacheWriteInputTokens: 0,
        outputTokens: 7,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: 120,
        inputTokens: 100,
        cachedInputTokens: 10,
        cacheWriteInputTokens: 5,
        outputTokens: 20,
        reasoningOutputTokens: 3,
      },
      modelContextWindow: 272_000,
    },
  };
}

function turnFixture(status: Turn['status'] = 'completed', error: Turn['error'] = null): Turn {
  return {
    id: TURN_ID,
    items: [],
    itemsView: 'notLoaded',
    status,
    error,
    startedAt: 1_786_284_007,
    completedAt: 1_786_284_012,
    durationMs: 5_000,
  };
}

export function turnCompleted(
  status: Turn['status'] = 'completed',
  error: Turn['error'] = null
): TurnCompletedNotification {
  return { threadId: THREAD_ID, turn: turnFixture(status, error) };
}

export function turnStartResponse(): TurnStartResponse {
  return { turn: turnFixture('inProgress') };
}

export function errorNotification(
  message: string,
  willRetry = false,
  turnId = TURN_ID
): ErrorNotification {
  return {
    error: { message, codexErrorInfo: 'usageLimitExceeded', additionalDetails: null },
    willRetry,
    threadId: THREAD_ID,
    turnId,
  };
}

export function commandApprovalParams(
  command: string,
  turnId = TURN_ID
): CommandExecutionRequestApprovalParams {
  return {
    threadId: THREAD_ID,
    turnId,
    itemId: 'item-cmd',
    startedAtMs: 1_500,
    environmentId: null,
    reason: 'Needs to run a command',
    command,
    cwd: '/workspace',
  };
}

export function fileChangeApprovalParams(turnId = TURN_ID): FileChangeRequestApprovalParams {
  return {
    threadId: THREAD_ID,
    turnId,
    itemId: 'item-patch',
    startedAtMs: 1_500,
    reason: 'Needs to write outside the sandbox',
    grantRoot: '/workspace',
  };
}

function threadFixture(id = THREAD_ID): Thread {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    modelProvider: 'openai',
    createdAt: 1_786_284_000,
    updatedAt: 1_786_284_000,
    recencyAt: null,
    status: { type: 'idle' },
    path: null,
    cwd: '/workspace',
    cliVersion: '0.147.0',
    source: 'appServer',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

export function threadStartResponse(
  overrides: Partial<ThreadStartResponse> = {}
): ThreadStartResponse {
  return {
    thread: threadFixture(),
    model: 'gpt-5.6-sol',
    modelProvider: 'openai',
    serviceTier: null,
    cwd: '/workspace',
    instructionSources: [],
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: {
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    reasoningEffort: null,
    ...overrides,
  };
}

export function permissionProfiles(
  overrides: Partial<Record<string, boolean>> = {}
): PermissionProfileSummary[] {
  return [':read-only', ':workspace', ':danger-full-access'].map((id) => ({
    id,
    description: null,
    allowed: overrides[id] ?? true,
  }));
}

export function modelFixture(id = 'gpt-5.6-sol'): Model {
  return {
    id,
    model: id,
    displayName: 'GPT-5.6-Sol',
    description: 'Latest frontier agentic coding model.',
    isDefault: true,
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' },
      { reasoningEffort: 'high', description: 'Deeper reasoning' },
    ],
    defaultReasoningEffort: 'medium',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    modelSpecialty: null,
    inputModalities: ['text', 'image'],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
  };
}
