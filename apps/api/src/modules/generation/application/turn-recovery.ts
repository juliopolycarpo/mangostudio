import type { MessagePart } from '@mangostudio/shared';
import type { AgentExecutionMode, AgentId } from '@mangostudio/shared/agents';
import {
  applyToolExecutionTransition,
  createToolExecutionSnapshot,
  inferToolExecutionSource,
  isTerminalToolExecutionStatus,
} from '@mangostudio/shared/tool-executions';
import {
  isTurnCheckpointPart,
  type ResumeInterruptedTurn,
  type TurnCheckpointPart,
  type TurnInterruptionReasonCode,
} from '@mangostudio/shared/turn-recovery';
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../../../db/types';
import { generateId } from '../../../utils/id';
import { linkAttachmentsToMessage } from '../../attachments/infrastructure/attachment-repository';
import { insertMessage } from '../../messages/infrastructure/message-repository';
import type { ResolvedModel } from './resolve-model';
import {
  classifyToolRetrySafety,
  createTurnCheckpointPart,
  refreshTurnCheckpointPart,
} from './turn-checkpoint';

const RECOVERY_PROMPT_MAX_LENGTH = 16_000;
const RECOVERY_RESULT_INITIAL_LENGTH = 512;
const RECOVERY_RESULT_MIN_LENGTH = 64;
const RECOVERY_ASSISTANT_TEXT_FLOOR = 2_000;
const RECOVERY_TODO_CONTENT_LENGTH = 80;
const RECOVERY_COMPLETED_CALL_INITIAL_LIMIT = 20;
const RECOVERY_INCOMPLETE_CALL_NAME_LENGTH = 40;
export const STALE_TURN_CHECKPOINT_AGE_MS = 10_000;

export class TurnRecoveryNotFoundError extends Error {
  constructor() {
    super('Interrupted turn not found.');
    this.name = 'TurnRecoveryNotFoundError';
  }
}

export class TurnRecoveryConflictError extends Error {
  constructor(message = 'This interrupted turn has already been handled.') {
    super(message);
    this.name = 'TurnRecoveryConflictError';
  }
}

export class TurnRecoveryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnRecoveryValidationError';
  }
}

interface OwnedRecoveryMessage {
  readonly id: string;
  readonly chatId: string;
  readonly text: string;
  readonly parts: string | null;
  readonly providerState: string | null;
  readonly isGenerating: number;
}

export interface InspectedTurnResume {
  readonly sourceMessageId: string;
  readonly checkpoint: TurnCheckpointPart;
  readonly effectivePrompt: string;
  readonly modelName: string;
  readonly agentMode: AgentExecutionMode;
  readonly agentId: AgentId;
}

export interface ReservedTurnResume {
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly effectivePrompt: string;
  readonly checkpoint: TurnCheckpointPart;
}

export async function inspectInterruptedTurnResume(
  input: {
    readonly chatId: string;
    readonly userId: string;
    readonly recovery: ResumeInterruptedTurn;
  },
  db: Kysely<Database>
): Promise<InspectedTurnResume> {
  const message = await getOwnedRecoveryMessage(
    input.chatId,
    input.recovery.messageId,
    input.userId,
    db
  );
  if (!message) throw new TurnRecoveryNotFoundError();
  const { checkpoint } = readRecoveryMessage(message);
  assertResumeAvailable(checkpoint, input.recovery);

  return {
    sourceMessageId: message.id,
    checkpoint,
    effectivePrompt: buildRecoveryPrompt(checkpoint, input.recovery.retryCallIds),
    modelName: checkpoint.modelName,
    agentMode: checkpoint.agentId === 'chat' ? 'chat' : 'agent',
    agentId: checkpoint.agentId,
  };
}

export function reserveInterruptedTurnResume(
  input: {
    readonly chatId: string;
    readonly userId: string;
    readonly displayPrompt: string;
    readonly attachmentIds?: string[];
    readonly recovery: ResumeInterruptedTurn;
    readonly inspected: InspectedTurnResume;
    readonly resolvedModel: ResolvedModel;
    readonly agentId: AgentId;
    readonly agentName?: string;
    readonly onTurnReserved: (assistantMessageId: string) => void;
  },
  db: Kysely<Database>
): Promise<ReservedTurnResume> {
  return db.transaction().execute(async (trx) => {
    const message = await getOwnedRecoveryMessage(
      input.chatId,
      input.recovery.messageId,
      input.userId,
      trx
    );
    if (!message) throw new TurnRecoveryNotFoundError();
    const { checkpoint, parts } = readRecoveryMessage(message);
    assertResumeAvailable(checkpoint, input.recovery);

    const now = Date.now();
    const userMessageId = generateId();
    const assistantMessageId = generateId();
    checkpoint.status = 'resumed';
    checkpoint.resume = {
      requestId: input.recovery.requestId,
      userMessageId,
      assistantMessageId,
      resumedAt: now,
    };

    const sourceUpdate = await trx
      .updateTable('messages')
      .set({ parts: JSON.stringify(parts) })
      .where('id', '=', message.id)
      .where('isGenerating', '=', 0)
      .where('parts', '=', message.parts)
      .executeTakeFirst();
    if (sourceUpdate.numUpdatedRows === 0n) throw new TurnRecoveryConflictError();

    const nextCheckpoint = createTurnCheckpointPart({
      turnId: assistantMessageId,
      startedAt: now,
      provider: input.resolvedModel.providerType ?? checkpoint.provider,
      modelName: input.resolvedModel.modelId,
      agentId: input.agentId,
      agentName: input.agentName,
    });
    const nextParts: MessagePart[] = [nextCheckpoint];

    await insertMessage(
      {
        id: userMessageId,
        chatId: input.chatId,
        role: 'user',
        text: input.displayPrompt,
        timestamp: now,
        isGenerating: false,
        interactionMode: input.agentId === 'chat' ? 'chat' : 'agent',
      },
      trx
    );
    if (input.attachmentIds && input.attachmentIds.length > 0) {
      await linkAttachmentsToMessage(
        {
          attachmentIds: input.attachmentIds,
          userId: input.userId,
          chatId: input.chatId,
          messageId: userMessageId,
          updatedAt: now,
        },
        trx
      );
    }
    input.onTurnReserved(assistantMessageId);
    await insertMessage(
      {
        id: assistantMessageId,
        chatId: input.chatId,
        role: 'ai',
        text: '',
        timestamp: now + 1,
        isGenerating: true,
        modelName: input.resolvedModel.modelId,
        interactionMode: input.agentId === 'chat' ? 'chat' : 'agent',
        parts: JSON.stringify(nextParts),
      },
      trx
    );

    return {
      userMessageId,
      assistantMessageId,
      effectivePrompt: input.inspected.effectivePrompt,
      checkpoint: nextCheckpoint,
    };
  });
}

export async function dismissInterruptedTurn(
  input: { readonly chatId: string; readonly messageId: string; readonly userId: string },
  db: Kysely<Database>
): Promise<void> {
  const message = await getOwnedRecoveryMessage(input.chatId, input.messageId, input.userId, db);
  if (!message) throw new TurnRecoveryNotFoundError();
  const { checkpoint, parts } = readRecoveryMessage(message);
  if (checkpoint.status !== 'interrupted') throw new TurnRecoveryConflictError();
  checkpoint.status = 'dismissed';
  const result = await db
    .updateTable('messages')
    .set({ parts: JSON.stringify(parts) })
    .where('id', '=', message.id)
    .where('parts', '=', message.parts)
    .executeTakeFirst();
  if (result.numUpdatedRows === 0n) throw new TurnRecoveryConflictError();
}

export async function assertCheckpointedTurnCanCancel(
  input: { readonly chatId: string; readonly messageId: string; readonly userId: string },
  db: Kysely<Database>
): Promise<void> {
  const message = await getOwnedRecoveryMessage(input.chatId, input.messageId, input.userId, db);
  if (!message) throw new TurnRecoveryNotFoundError();
  const { checkpoint } = readRecoveryMessage(message);
  if (message.isGenerating !== 1 || checkpoint.status !== 'active') {
    throw new TurnRecoveryConflictError('This turn is no longer running.');
  }
}

export async function interruptCheckpointedMessage(
  input: {
    readonly messageId: string;
    readonly reasonCode: TurnInterruptionReasonCode;
    readonly checkpointedBefore?: number;
  },
  db: Kysely<Database>
): Promise<boolean> {
  const row = await db
    .selectFrom('messages')
    .select(['id', 'text', 'parts', 'providerState', 'isGenerating'])
    .where('id', '=', input.messageId)
    .executeTakeFirst();
  if (row?.isGenerating !== 1) return false;

  const parsed = parseMessageParts(row.parts);
  const checkpoint = parsed.find(isTurnCheckpointPart);
  if (
    input.checkpointedBefore !== undefined &&
    (!checkpoint || checkpoint.checkpointedAt > input.checkpointedBefore)
  ) {
    return false;
  }
  reconcileInterruptedMessageParts(parsed);
  // A row without a readable checkpoint predates turn recovery or came from the
  // message create route. It carries no resumable state, but clearing
  // `isGenerating` still matters: otherwise it spins in the UI forever and every
  // later reconcile pass re-reads it.
  if (checkpoint) {
    refreshTurnCheckpointPart(
      checkpoint,
      { text: row.text, parts: parsed, providerState: row.providerState },
      Date.now(),
      { force: true, status: 'interrupted', reasonCode: input.reasonCode }
    );
  }
  sealUnresolvedToolCalls(parsed);

  const result = await db
    .updateTable('messages')
    .set({
      ...(parsed.length > 0 ? { parts: JSON.stringify(parsed) } : {}),
      isGenerating: 0,
    })
    .where('id', '=', input.messageId)
    .where('isGenerating', '=', 1)
    .executeTakeFirst();
  return result.numUpdatedRows > 0n;
}

export async function reconcileStaleTurns(
  input:
    | {
        readonly chatId?: string;
        readonly reasonCode: 'server_restart';
      }
    | {
        readonly chatId?: string;
        readonly reasonCode: 'unknown';
        readonly isActive: (messageId: string) => boolean;
      },
  db: Kysely<Database>
): Promise<number> {
  // Only the id is needed: interruptCheckpointedMessage re-reads each candidate
  // row under its own isGenerating guard.
  let query = db
    .selectFrom('messages')
    .select(['id'])
    .where('role', '=', 'ai')
    .where('isGenerating', '=', 1);
  if (input.chatId) query = query.where('chatId', '=', input.chatId);

  const rows = await query.execute();
  const checkpointedBefore =
    input.reasonCode === 'unknown' ? Date.now() - STALE_TURN_CHECKPOINT_AGE_MS : undefined;
  let reconciled = 0;
  for (const row of rows) {
    if (input.reasonCode === 'unknown' && input.isActive(row.id)) continue;
    if (
      await interruptCheckpointedMessage(
        { messageId: row.id, reasonCode: input.reasonCode, checkpointedBefore },
        db
      )
    ) {
      reconciled += 1;
    }
  }
  return reconciled;
}

export function buildRecoveryPrompt(
  checkpoint: TurnCheckpointPart,
  retryCallIds: readonly string[]
): string {
  const retryIds = new Set(retryCallIds);
  const prefix = [
    'Continue the interrupted turn from the durable recovery checkpoint below.',
    'Treat succeeded call IDs and their results as authoritative. Do not repeat them.',
    'Do not retry incomplete calls unless their call ID appears in selectedRetryCallIds.',
    'For calls with an unknown outcome, verify state before attempting any mutation.',
    'Fields marked omitted were dropped to fit the size budget; verify independently.',
    '<turn-recovery>',
  ].join('\n');
  const suffix = '\n</turn-recovery>';
  const selectedRetryCalls = checkpoint.incompleteCalls.filter((call) => retryIds.has(call.callId));
  const selectedRetryCallIds = selectedRetryCalls.map((call) => call.callId);
  const state: RecoveryPromptState = {
    durableContent: checkpoint.lastAssistantText,
    resultLength: RECOVERY_RESULT_INITIAL_LENGTH,
    todoSnapshot: checkpoint.todoSnapshot,
    todoSnapshotOmitted: false,
    completedCallLimit: null,
    summarizeIncompleteCalls: false,
  };

  const render = () => {
    let completedCalls = checkpoint.completedCalls;
    if (state.completedCallLimit !== null) {
      completedCalls =
        state.completedCallLimit === 0
          ? []
          : checkpoint.completedCalls.slice(-state.completedCallLimit);
    }
    const omittedCompletedCallCount = checkpoint.completedCalls.length - completedCalls.length;
    const succeeded = completedCalls.filter((call) => !call.isError);
    const failed = completedCalls.filter((call) => call.isError);
    const omittedIncompleteCalls = state.summarizeIncompleteCalls
      ? checkpoint.incompleteCalls.filter((call) => !retryIds.has(call.callId))
      : [];
    const incompleteCalls = state.summarizeIncompleteCalls
      ? selectedRetryCalls
      : checkpoint.incompleteCalls;

    return `${prefix}\n${encodeRecoveryPayload({
      interruptedTurnId: checkpoint.turnId,
      interruptionReason: checkpoint.reasonCode ?? 'unknown',
      lastDurableAssistantContent: state.durableContent,
      ...(state.todoSnapshotOmitted
        ? { todoSnapshotOmitted: true }
        : { todoSnapshot: state.todoSnapshot }),
      succeededCalls: succeeded.map((call) => ({
        callId: call.callId,
        name: call.name,
        result: call.result.slice(0, state.resultLength),
      })),
      failedCalls: failed.map((call) => ({
        callId: call.callId,
        name: call.name,
        result: call.result.slice(0, state.resultLength),
      })),
      ...(omittedCompletedCallCount > 0 ? { omittedCompletedCallCount } : {}),
      incompleteCalls: incompleteCalls.map((call) => ({
        callId: call.callId,
        name: call.name,
        retrySafety: call.retrySafety,
        outcome: call.outcome,
      })),
      ...(omittedIncompleteCalls.length > 0
        ? {
            omittedIncompleteCallCount: omittedIncompleteCalls.length,
            omittedIncompleteCallNames: [
              ...new Set(
                omittedIncompleteCalls.map((call) =>
                  call.name.slice(0, RECOVERY_INCOMPLETE_CALL_NAME_LENGTH)
                )
              ),
            ],
          }
        : {}),
      selectedRetryCallIds,
    })}${suffix}`;
  };

  let prompt = render();
  const trimPasses: Array<() => boolean> = [
    () => trimResultLength(state),
    () => trimAssistantTextToFloor(state, RECOVERY_ASSISTANT_TEXT_FLOOR),
    () => truncateTodoContents(state),
    () => dropCompletedTodos(state),
    () => omitTodoSnapshot(state),
    () => reduceCompletedCallLimit(state, checkpoint.completedCalls.length),
    () =>
      summarizeIncompleteCalls(state, checkpoint.incompleteCalls.length, selectedRetryCalls.length),
    () => trimAssistantTextToFloor(state, 0),
  ];

  for (const trim of trimPasses) {
    while (prompt.length > RECOVERY_PROMPT_MAX_LENGTH && trim()) prompt = render();
    if (prompt.length <= RECOVERY_PROMPT_MAX_LENGTH) return prompt;
  }

  const minimalPrompt = `${prefix}\n${encodeRecoveryPayload({
    interruptedTurnId: checkpoint.turnId,
    interruptionReason: checkpoint.reasonCode ?? 'unknown',
    selectedRetryCallIds,
    recoveryContextOmitted: true,
  })}${suffix}`;
  if (minimalPrompt.length <= RECOVERY_PROMPT_MAX_LENGTH) return minimalPrompt;

  return `${prefix}\n${encodeRecoveryPayload({
    interruptedTurnId: checkpoint.turnId,
    interruptionReason: checkpoint.reasonCode ?? 'unknown',
    retrySelectionOmitted: true,
    recoveryContextOmitted: true,
  })}${suffix}`;
}

/**
 * `JSON.stringify` leaves `<` unescaped, so checkpoint content holding a literal
 * `</turn-recovery>` would close the block early and let model- or tool-authored
 * text pose as top-level recovery instructions. `<` keeps the payload valid
 * JSON while making the closing delimiter unforgeable.
 */
function encodeRecoveryPayload(payload: unknown): string {
  return JSON.stringify(payload).replaceAll('<', '\\u003c');
}

interface RecoveryPromptState {
  durableContent: string;
  resultLength: number;
  todoSnapshot: TurnCheckpointPart['todoSnapshot'];
  todoSnapshotOmitted: boolean;
  completedCallLimit: number | null;
  summarizeIncompleteCalls: boolean;
}

function trimResultLength(state: RecoveryPromptState): boolean {
  if (state.resultLength <= RECOVERY_RESULT_MIN_LENGTH) return false;
  state.resultLength = Math.max(RECOVERY_RESULT_MIN_LENGTH, Math.floor(state.resultLength / 2));
  return true;
}

function trimAssistantTextToFloor(state: RecoveryPromptState, floor: number): boolean {
  if (state.durableContent.length <= floor) return false;
  const nextLength = Math.max(floor, Math.floor(state.durableContent.length / 2));
  state.durableContent = state.durableContent.slice(0, nextLength);
  return true;
}

function truncateTodoContents(state: RecoveryPromptState): boolean {
  if (!state.todoSnapshot.some((todo) => todo.content.length > RECOVERY_TODO_CONTENT_LENGTH)) {
    return false;
  }
  state.todoSnapshot = state.todoSnapshot.map((todo) => ({
    ...todo,
    content: todo.content.slice(0, RECOVERY_TODO_CONTENT_LENGTH),
  }));
  return true;
}

function dropCompletedTodos(state: RecoveryPromptState): boolean {
  if (!state.todoSnapshot.some((todo) => todo.status === 'completed')) return false;
  state.todoSnapshot = state.todoSnapshot.filter((todo) => todo.status !== 'completed');
  if (state.todoSnapshot.length === 0) state.todoSnapshotOmitted = true;
  return true;
}

function omitTodoSnapshot(state: RecoveryPromptState): boolean {
  if (state.todoSnapshot.length === 0) return false;
  state.todoSnapshot = [];
  state.todoSnapshotOmitted = true;
  return true;
}

function reduceCompletedCallLimit(state: RecoveryPromptState, totalCount: number): boolean {
  const currentCount = state.completedCallLimit ?? totalCount;
  if (currentCount === 0) return false;
  state.completedCallLimit =
    currentCount > RECOVERY_COMPLETED_CALL_INITIAL_LIMIT
      ? RECOVERY_COMPLETED_CALL_INITIAL_LIMIT
      : Math.floor(currentCount / 2);
  return state.completedCallLimit < currentCount;
}

function summarizeIncompleteCalls(
  state: RecoveryPromptState,
  totalCount: number,
  selectedCount: number
): boolean {
  if (state.summarizeIncompleteCalls || totalCount === selectedCount) return false;
  state.summarizeIncompleteCalls = true;
  return true;
}

function assertResumeAvailable(
  checkpoint: TurnCheckpointPart,
  recovery: ResumeInterruptedTurn
): void {
  if (checkpoint.status !== 'interrupted') throw new TurnRecoveryConflictError();
  const incomplete = new Map(checkpoint.incompleteCalls.map((call) => [call.callId, call]));
  for (const callId of recovery.retryCallIds) {
    if (!incomplete.has(callId)) {
      throw new TurnRecoveryValidationError(
        `Tool call "${callId}" is not retryable from this checkpoint.`
      );
    }
  }
}

function readRecoveryMessage(message: OwnedRecoveryMessage): {
  checkpoint: TurnCheckpointPart;
  parts: MessagePart[];
} {
  const parts = parseMessageParts(message.parts);
  const checkpoint = parts.find(isTurnCheckpointPart);
  if (!checkpoint) throw new TurnRecoveryNotFoundError();
  return { checkpoint, parts };
}

function parseMessageParts(raw: string | null): MessagePart[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MessagePart[]) : [];
  } catch {
    return [];
  }
}

function getOwnedRecoveryMessage(
  chatId: string,
  messageId: string,
  userId: string,
  db: Kysely<Database> | Transaction<Database>
): Promise<OwnedRecoveryMessage | undefined> {
  return db
    .selectFrom('messages')
    .innerJoin('chats', 'chats.id', 'messages.chatId')
    .select([
      'messages.id',
      'messages.chatId',
      'messages.text',
      'messages.parts',
      'messages.providerState',
      'messages.isGenerating',
    ])
    .where('messages.id', '=', messageId)
    .where('messages.chatId', '=', chatId)
    .where('chats.userId', '=', userId)
    .executeTakeFirst();
}

export function reconcileInterruptedMessageParts(parts: MessagePart[]): void {
  const resultIds = new Set(
    parts.filter((part) => part.type === 'tool_result').map((part) => part.toolCallId)
  );
  for (const part of parts) {
    if (part.type === 'mcp_elicitation' && part.status === 'pending') {
      part.status = 'cancelled';
      part.reason = 'turn_aborted';
      continue;
    }
    if (part.type !== 'tool_call' || resultIds.has(part.toolCallId)) continue;
    const current =
      part.execution ??
      createToolExecutionSnapshot(inferToolExecutionSource(part.name), Date.now());
    if (isTerminalToolExecutionStatus(current.status)) continue;
    const outcomeUnknown =
      current.status === 'running' && classifyToolRetrySafety(part.name) !== 'safe_read';
    part.execution = applyToolExecutionTransition(current, {
      status: 'cancelled',
      at: Date.now(),
      reasonCode: outcomeUnknown ? 'outcome_unknown' : 'turn_aborted',
    });
  }
}

/**
 * Appends a synthetic error result for every tool call left without one.
 * Providers reject a replayed tool call that carries no matching result, so an
 * unsealed turn would break every later turn in the chat.
 *
 * Must run after the checkpoint is refreshed: the checkpoint derives
 * `incompleteCalls` from the calls that still have no result.
 */
export function sealUnresolvedToolCalls(parts: MessagePart[]): void {
  const resultIds = new Set(
    parts.filter((part) => part.type === 'tool_result').map((part) => part.toolCallId)
  );
  const sealed: MessagePart[] = [];
  for (const part of parts) {
    if (part.type !== 'tool_call' || resultIds.has(part.toolCallId)) continue;
    resultIds.add(part.toolCallId);
    sealed.push({
      type: 'tool_result',
      toolCallId: part.toolCallId,
      content: JSON.stringify({
        error:
          part.execution?.reasonCode === 'outcome_unknown'
            ? 'The turn was interrupted while this tool call was running; its outcome is unknown.'
            : 'The turn was interrupted before this tool call produced a result.',
      }),
      isError: true,
    });
  }
  parts.push(...sealed);
}
