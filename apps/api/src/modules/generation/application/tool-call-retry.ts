/**
 * A user's retry of one tool call, run as a tool-only turn.
 *
 * The call goes through the same executor a model turn uses (allow-list, tool
 * settings, timeouts, the durable start marker, file checkpoints), with no
 * model call around it. The result is appended to the original assistant
 * message as a new call linked by `retryOf` and marked `initiatedBy: 'user'`;
 * the original call keeps the state it ended in.
 *
 * Two phases, so a refusal is a plain HTTP error and not a frame in a stream:
 * {@link reserveToolCallRetry} validates and reopens the message, and
 * {@link runToolCallRetry} runs the call and settles the message.
 */

import { mergeMessageParts } from '@mangostudio/shared/generation';
import {
  resolveToolCallRetryEligibility,
  resolveToolCallStatus,
  type ToolCallRetryRefusal,
} from '@mangostudio/shared/tool-executions';
import { isTurnCheckpointPart, type TurnCheckpointPart } from '@mangostudio/shared/turn-recovery';
import type { MessagePart } from '@mangostudio/shared/types';
import type { Kysely } from 'kysely';

import type { Database } from '../../../db/types';
import { generateId } from '../../../utils/id';
import { AgentSettingsError } from '../../agents/domain/agent-profile';
import { getOwnedChat, type OwnedChatRecord } from '../../chats/infrastructure/chat-repository';
import { publishGitTurnCompletionInvalidation } from '../../git/application/git-realtime-service';
import { finalizeCheckpointedAiResponse } from '../infrastructure/conversation-persistence';
import { findActiveTurnByChat } from './active-turn-registry';
import { resolveRunnerAgentProfile } from './resolve-runner-agent';
import { resolveTurnToolRuntime, type TurnToolRuntime } from './resolve-turn-context';
import { executeStandardToolCallsWithProgress } from './standard-tool-execution';
import {
  collectToolExecutionResult,
  createToolStartMarkerWriter,
  synchronizeToolProgressForCheckpoint,
} from './stream-text-turn-helpers';
import type { StreamEvent } from './stream-text-turn-types';
import { classifyToolRetrySafety } from './tool-retry-safety';
import { createDatabaseCheckpointStore, TurnCheckpointWriter } from './turn-checkpoint';
import { describeTurnFailure } from './turn-failure';
import { reconcileInterruptedMessageParts, sealUnresolvedToolCalls } from './turn-recovery';

export class ToolCallRetryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolCallRetryNotFoundError';
  }
}

/** The call, message or chat is in a state that cannot take a retry right now. */
export class ToolCallRetryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolCallRetryConflictError';
  }
}

/** The retry needs the reader's approval and the request did not carry it. */
export class ToolCallRetryConfirmationRequiredError extends Error {
  constructor(readonly toolName: string) {
    super(`Retrying "${toolName}" needs the user's confirmation.`);
    this.name = 'ToolCallRetryConfirmationRequiredError';
  }
}

const REFUSAL_MESSAGES: Readonly<Record<ToolCallRetryRefusal, string>> = {
  not_terminal: 'it has not failed, been cancelled or timed out.',
  same_refusal: 'it was refused by policy before it ran, and the same call would be refused again.',
  no_policy: 'it recorded no retry policy.',
  needs_model: 'it needs a model turn to finish.',
};

export interface ReserveToolCallRetryInput {
  readonly chatId: string;
  readonly messageId: string;
  /** The `toolCallId` of the call to run again. */
  readonly callId: string;
  readonly userId: string;
  /** The reader approved the confirmation naming the tool and its arguments. */
  readonly confirmed: boolean;
  /**
   * Called with the message id before the message is reopened, so the turn is
   * registered by the time any reader can see it generating.
   */
  readonly onTurnReserved: (messageId: string) => void;
}

export interface ReservedToolCallRetry {
  readonly chat: OwnedChatRecord;
  readonly chatId: string;
  readonly userId: string;
  readonly messageId: string;
  /** The new call's id. */
  readonly callId: string;
  readonly retryOf: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  /** The message as it stood before the retry; the original call is in here untouched. */
  readonly parts: MessagePart[];
  readonly text: string;
  readonly providerState: string | null;
  readonly generationTime: string | null;
  readonly modelName: string;
  readonly checkpoint: TurnCheckpointPart;
  readonly runtime: TurnToolRuntime;
}

/**
 * Validates a retry and reopens its message, or throws a refusal.
 *
 * Refuses when: the chat or call does not exist, the chat runs an external
 * agent, any turn is running in the chat, the call did not end in a state that
 * offers a retry, the tool is no longer allowed for the agent, or the policy
 * asks first and the request is not confirmed.
 *
 * The reopen is one conditional write that also checks no message in the chat
 * is generating, so two retries (or a retry and a send) cannot both win.
 */
export async function reserveToolCallRetry(
  input: ReserveToolCallRetryInput,
  db: Kysely<Database>
): Promise<ReservedToolCallRetry> {
  const chat = await getOwnedChat(input.chatId, input.userId, db);
  if (!chat) throw new ToolCallRetryNotFoundError('Chat not found');
  if (chat.runner.kind === 'external') {
    throw new ToolCallRetryConflictError(
      'Tool calls of an external agent run in its own session and cannot be retried here.'
    );
  }

  const message = await db
    .selectFrom('messages')
    .select(['id', 'role', 'text', 'parts', 'providerState', 'generationTime', 'modelName'])
    .where('id', '=', input.messageId)
    .where('chatId', '=', input.chatId)
    .executeTakeFirst();
  if (message?.role !== 'ai') throw new ToolCallRetryNotFoundError('Message not found');
  // Also covers this message still generating: its row is one of the chat's.
  await assertNoRunningTurn(input.chatId, db);

  const parts = parseParts(message.parts);
  const original = parts.find(
    (part): part is Extract<MessagePart, { type: 'tool_call' }> =>
      part.type === 'tool_call' && part.toolCallId === input.callId
  );
  if (!original) throw new ToolCallRetryNotFoundError('Tool call not found');
  const checkpoint = parts.find(isTurnCheckpointPart);
  if (!checkpoint) {
    throw new ToolCallRetryConflictError('This message recorded no turn to run the call under.');
  }

  assertRetryOffered(original, parts);
  const eligibility = resolveToolCallRetryEligibility({
    name: original.name,
    status: resolveToolCallStatus({
      execution: original.execution,
      hasResult: parts.some(
        (part) => part.type === 'tool_result' && part.toolCallId === original.toolCallId
      ),
      isError: parts.some(
        (part) =>
          part.type === 'tool_result' && part.toolCallId === original.toolCallId && part.isError
      ),
      isStreaming: false,
    }),
    reasonCode: original.execution?.reasonCode,
    // The tool's policy today, not the one stamped when the call ran: a tool
    // reclassified since must not skip a confirmation it now needs.
    retrySafety: classifyToolRetrySafety(original.name),
  });
  if (!eligibility.eligible) {
    throw new ToolCallRetryConflictError(
      `Tool call "${original.name}" cannot be retried: ${REFUSAL_MESSAGES[eligibility.reason]}`
    );
  }
  if (eligibility.confirmation === 'required' && !input.confirmed) {
    throw new ToolCallRetryConfirmationRequiredError(original.name);
  }

  const runtime = await resolveRuntime(chat, checkpoint, input.userId, db);
  if (!runtime.allowedToolNames.has(original.name)) {
    throw new ToolCallRetryConflictError(
      `Tool "${original.name}" is not allowed for this agent right now.`
    );
  }

  input.onTurnReserved(input.messageId);
  const reopened = await db
    .updateTable('messages')
    .set({ isGenerating: 1 })
    .where('id', '=', input.messageId)
    .where('chatId', '=', input.chatId)
    .where('role', '=', 'ai')
    .where('isGenerating', '=', 0)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('messages')
            .select('id')
            .where('chatId', '=', input.chatId)
            .where('isGenerating', '=', 1)
        )
      )
    )
    .executeTakeFirst();
  if (reopened.numUpdatedRows === 0n) {
    throw new ToolCallRetryConflictError('A turn is running in this chat.');
  }

  return {
    chat,
    chatId: input.chatId,
    userId: input.userId,
    messageId: input.messageId,
    callId: generateId(),
    retryOf: original.toolCallId,
    name: original.name,
    args: original.args,
    parts,
    text: message.text,
    providerState: message.providerState,
    generationTime: message.generationTime,
    modelName: message.modelName ?? checkpoint.modelName,
    checkpoint,
    runtime,
  };
}

/** A turn in this chat, internal or external, running now or marked generating. */
async function assertNoRunningTurn(chatId: string, db: Kysely<Database>): Promise<void> {
  const running =
    findActiveTurnByChat(chatId) !== undefined ||
    (await db
      .selectFrom('messages')
      .select('id')
      .where('chatId', '=', chatId)
      .where('isGenerating', '=', 1)
      .executeTakeFirst()) !== undefined;
  if (running) throw new ToolCallRetryConflictError('A turn is running in this chat.');
}

/** A call already re-run by the user offers no second retry from the same card. */
function assertRetryOffered(
  original: Extract<MessagePart, { type: 'tool_call' }>,
  parts: MessagePart[]
): void {
  const retried = parts.some(
    (part) => part.type === 'tool_call' && part.retryOf === original.toolCallId
  );
  if (retried) {
    throw new ToolCallRetryConflictError(
      `Tool call "${original.name}" was already retried; retry the newer call instead.`
    );
  }
}

async function resolveRuntime(
  chat: OwnedChatRecord,
  checkpoint: TurnCheckpointPart,
  userId: string,
  db: Kysely<Database>
): Promise<TurnToolRuntime> {
  try {
    const agent = await resolveRunnerAgentProfile({
      db,
      userId,
      runner: chat.runner,
      agentId: checkpoint.agentId,
    });
    return await resolveTurnToolRuntime(
      {
        chat,
        userId,
        agentId: agent.agentId,
        profile: agent.profile,
        provider: checkpoint.provider,
      },
      db
    );
  } catch (error) {
    if (error instanceof AgentSettingsError && error.status === 404) {
      throw new ToolCallRetryNotFoundError('Agent not found');
    }
    throw error;
  }
}

function parseParts(raw: string | null): MessagePart[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MessagePart[]) : [];
  } catch {
    return [];
  }
}

/**
 * Runs the reserved call and settles the message. Emits `assistant_message_id`,
 * the call's lifecycle and result events, then `done` or `error`. The message
 * is settled before the last event, on every path including an abort.
 */
export async function* runToolCallRetry(
  reserved: ReservedToolCallRetry,
  db: Kysely<Database>,
  signal: AbortSignal
): AsyncGenerator<StreamEvent> {
  const startedAt = Date.now();
  const parts = [...reserved.parts];
  // The new call sits beside the original. Its own part carries the link and
  // the origin, and the pipeline upserts its lifecycle into this same part.
  parts.push({
    type: 'tool_call',
    toolCallId: reserved.callId,
    name: reserved.name,
    args: reserved.args,
    retryOf: reserved.retryOf,
    initiatedBy: 'user',
  });

  // A copy of the checkpoint that is not in `parts`: the writer advances its
  // own sequence and status, while the message keeps the checkpoint the turn
  // that ran the original call ended with.
  const writer = new TurnCheckpointWriter({
    store: createDatabaseCheckpointStore(db, reserved.messageId),
    chatId: reserved.chatId,
    messageId: reserved.messageId,
    checkpoint: structuredClone(reserved.checkpoint),
    getContent: () => ({
      text: reserved.text,
      parts,
      providerState: reserved.providerState,
      generationTime: reserved.generationTime,
    }),
  });
  const beforeToolStart = createToolStartMarkerWriter({
    allParts: parts,
    checkpointWriter: writer,
  });

  yield { type: 'assistant_message_id', messageId: reserved.messageId };

  let failure: unknown;
  try {
    for await (const item of executeStandardToolCallsWithProgress(
      [[reserved.callId, { name: reserved.name, argsStr: JSON.stringify(reserved.args) }]],
      {
        userId: reserved.userId,
        chatId: reserved.chatId,
        environmentId: reserved.chat.environmentId,
        assistantMessageId: reserved.messageId,
        workdir: reserved.runtime.workdir,
        workdirPolicy: reserved.runtime.workdirPolicy,
        settingsByToolName: reserved.runtime.agentRuntime.toolSettingsByName,
        allowedToolNames: reserved.runtime.allowedToolNames,
        db,
        signal,
        beforeToolStart,
      }
    )) {
      synchronizeToolProgressForCheckpoint(item, parts);
      yield* collectToolExecutionResult(item, {
        allParts: parts,
        // No model reads these: the results are in the message for the next turn.
        nextToolResults: [],
        includeSubagentTrace: false,
      });
      await writer.checkpoint({ force: true });
    }
  } catch (error) {
    failure = error;
  }

  const generationTime = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  try {
    writer.close();
    await writer.flush();
    reconcileInterruptedMessageParts(parts);
    sealUnresolvedToolCalls(parts);
    const finalized = await finalizeCheckpointedAiResponse(
      {
        id: reserved.messageId,
        userId: reserved.userId,
        chatId: reserved.chatId,
        text: reserved.text,
        parts: mergeMessageParts(parts),
        providerState: reserved.providerState,
        // The message keeps the time of the turn that produced its text.
        generationTime: reserved.generationTime ?? generationTime,
        modelName: reserved.modelName,
      },
      db
    );
    if (!finalized) {
      yield { type: 'error', error: 'The message was closed before the retry finished.' };
      return;
    }
  } finally {
    publishGitTurnCompletionInvalidation({
      userId: reserved.userId,
      chatId: reserved.chatId,
      environmentId: reserved.chat.environmentId,
    });
  }

  if (failure !== undefined && !signal.aborted) {
    const { message, code } = describeTurnFailure(failure);
    yield { type: 'error', error: message, ...(code ? { code } : {}) };
    return;
  }
  yield { type: 'done', messageId: reserved.messageId, generationTime };
}
