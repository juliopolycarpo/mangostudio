/**
 * Fixture factories built from the **vendored Codex contract**, not from hand-
 * written JSON.
 *
 * Every builder's return type is one of the generated types under
 * `src/services/external-agents/codex/protocol`, so a scenario composed from
 * these is type-checked against the vendor's own shapes. When
 * `bun run vendor-contracts:regen` pulls in a version that renames or retypes a
 * field, the build breaks here — loudly, at the point the assumption lives —
 * instead of a stale literal continuing to satisfy a test that no longer
 * describes the protocol.
 *
 * Real captures pin *ordering*; these pin *shape*. Both are needed, and neither
 * substitutes for the other.
 */

import type { AgentMessageDeltaNotification } from '../../src/services/external-agents/codex/protocol/v2/AgentMessageDeltaNotification';
import type { CommandExecutionOutputDeltaNotification } from '../../src/services/external-agents/codex/protocol/v2/CommandExecutionOutputDeltaNotification';
import type { CommandExecutionRequestApprovalParams } from '../../src/services/external-agents/codex/protocol/v2/CommandExecutionRequestApprovalParams';
import type { ErrorNotification } from '../../src/services/external-agents/codex/protocol/v2/ErrorNotification';
import type { FileChangePatchUpdatedNotification } from '../../src/services/external-agents/codex/protocol/v2/FileChangePatchUpdatedNotification';
import type { FileChangeRequestApprovalParams } from '../../src/services/external-agents/codex/protocol/v2/FileChangeRequestApprovalParams';
import type { FileUpdateChange } from '../../src/services/external-agents/codex/protocol/v2/FileUpdateChange';
import type { ItemCompletedNotification } from '../../src/services/external-agents/codex/protocol/v2/ItemCompletedNotification';
import type { ItemStartedNotification } from '../../src/services/external-agents/codex/protocol/v2/ItemStartedNotification';
import type { McpToolCallProgressNotification } from '../../src/services/external-agents/codex/protocol/v2/McpToolCallProgressNotification';
import type { Model } from '../../src/services/external-agents/codex/protocol/v2/Model';
import type { PatchChangeKind } from '../../src/services/external-agents/codex/protocol/v2/PatchChangeKind';
import type { PermissionProfileSummary } from '../../src/services/external-agents/codex/protocol/v2/PermissionProfileSummary';
import type { ReasoningSummaryTextDeltaNotification } from '../../src/services/external-agents/codex/protocol/v2/ReasoningSummaryTextDeltaNotification';
import type { ReviewStartResponse } from '../../src/services/external-agents/codex/protocol/v2/ReviewStartResponse';
import type { Thread } from '../../src/services/external-agents/codex/protocol/v2/Thread';
import type { ThreadItem } from '../../src/services/external-agents/codex/protocol/v2/ThreadItem';
import type { ThreadListResponse } from '../../src/services/external-agents/codex/protocol/v2/ThreadListResponse';
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
    changes: paths.map((path) => fileUpdateChange(path)),
    status,
  };
}

/**
 * One `FileUpdateChange`, with the **tagged** kind the vendor actually sends.
 *
 * `kind` is an object, not a string, which is the whole reason this builder
 * exists: a hand-written `kind: 'update'` would type-error here rather than
 * quietly producing a rendering nobody notices until it reaches a transcript.
 */
export function fileUpdateChange(
  path: string,
  kind: PatchChangeKind = { type: 'update', move_path: null }
): FileUpdateChange {
  return { path, kind, diff: '' };
}

export function fileChangeItemWithChanges(
  id: string,
  changes: readonly FileUpdateChange[]
): ThreadItem {
  return { type: 'fileChange', id, changes: [...changes], status: 'completed' };
}

export function commandOutputDelta(
  itemId: string,
  delta: string,
  turnId = TURN_ID
): CommandExecutionOutputDeltaNotification {
  return { threadId: THREAD_ID, turnId, itemId, delta };
}

export function mcpToolCallProgress(
  itemId: string,
  message: string,
  turnId = TURN_ID
): McpToolCallProgressNotification {
  return { threadId: THREAD_ID, turnId, itemId, message };
}

export function fileChangePatchUpdated(
  itemId: string,
  changes: readonly FileUpdateChange[],
  turnId = TURN_ID
): FileChangePatchUpdatedNotification {
  return { threadId: THREAD_ID, turnId, itemId, changes: [...changes] };
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

/**
 * `review/start`'s answer. `reviewThreadId` defaults to the thread the review
 * was asked for, which is what inline delivery is documented to return — a test
 * overrides it to make the adapter face a detached one.
 */
export function reviewStartResponse(reviewThreadId: string = THREAD_ID): ReviewStartResponse {
  return { turn: turnFixture('inProgress'), reviewThreadId };
}

export function enteredReviewModeItem(id: string, review: string): ThreadItem {
  return { type: 'enteredReviewMode', id, review };
}

export function exitedReviewModeItem(id: string, review: string): ThreadItem {
  return { type: 'exitedReviewMode', id, review };
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

/**
 * A `thread/list` page built from the vendored `Thread` shape.
 *
 * Deliberately mixed: a named user thread, an unnamed one that only has a
 * preview, an ephemeral thread and a subagent's. A mapper that forwards all
 * four — or that reads `sessionId` where it should read `id` — fails against
 * this rather than against a hand-written literal that agreed with it.
 */
export function threadListResponse(
  overrides: { readonly nextCursor?: string | null } = {}
): ThreadListResponse {
  return {
    data: [
      {
        ...threadFixture('019fe6d2-aaaa-7420-b12c-000000000001'),
        // Different from `id` on purpose: `sessionId` is the id shared by a
        // whole thread tree, and adopting it would resume nothing.
        sessionId: 'session-tree-0001',
        name: 'Fix the flaky test',
        preview: 'the retry loop keeps timing out',
        recencyAt: 1_786_284_100,
        updatedAt: 1_786_284_000,
        source: 'cli',
      },
      {
        ...threadFixture('019fe6d2-bbbb-7420-b12c-000000000002'),
        sessionId: 'session-tree-0002',
        name: null,
        preview: 'add a migration for the lease table',
        recencyAt: null,
        updatedAt: 1_786_283_000,
        source: 'cli',
      },
      {
        ...threadFixture('019fe6d2-cccc-7420-b12c-000000000003'),
        ephemeral: true,
        preview: 'scratch',
      },
      {
        ...threadFixture('019fe6d2-dddd-7420-b12c-000000000004'),
        parentThreadId: '019fe6d2-aaaa-7420-b12c-000000000001',
        agentRole: 'reviewer',
        preview: 'review the diff',
      },
    ],
    nextCursor: overrides.nextCursor ?? null,
    backwardsCursor: null,
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
