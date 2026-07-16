import type { MessagePart } from '@mangostudio/shared';
import {
  isTerminalToolExecutionStatus,
  type ToolExecutionReasonCode,
  type ToolExecutionStatus,
} from '@mangostudio/shared/tool-executions';
import {
  type CompletedToolCall,
  type IncompleteToolCall,
  type IncompleteToolCallOutcome,
  type ToolRetrySafety,
  TURN_RECOVERY_MAX_CALLS,
  TURN_RECOVERY_MAX_RESULT_LENGTH,
  TURN_RECOVERY_MAX_TEXT_LENGTH,
  type TurnCheckpointPart,
  type TurnCheckpointStatus,
  type TurnInterruptionReasonCode,
} from '@mangostudio/shared/turn-recovery';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { logPersistenceError } from '../../../services/providers/core/continuation-logger';

export const CHECKPOINT_TEXT_INTERVAL_CHARS = 512;
export const CHECKPOINT_MAX_INTERVAL_MS = 1_000;

const READ_ONLY_BUILTIN_TOOLS = new Set([
  'get_current_datetime',
  'glob',
  'grep',
  'list_directory',
  'read_file',
  'skill',
]);

export interface TurnCheckpointContent {
  readonly text: string;
  readonly parts: MessagePart[];
  readonly providerState: string | null;
  readonly generationTime?: string | null;
}

interface TurnCheckpointWriterOptions {
  readonly db: Kysely<Database>;
  readonly chatId: string;
  readonly messageId: string;
  readonly checkpoint: TurnCheckpointPart;
  readonly getContent: () => TurnCheckpointContent;
  readonly now?: () => number;
}

export interface WriteTurnCheckpointOptions {
  readonly force?: boolean;
  readonly status?: TurnCheckpointStatus;
  readonly reasonCode?: TurnInterruptionReasonCode;
}

/**
 * Serializes bounded checkpoint writes for one assistant row. Text deltas are
 * throttled, while callers force writes at durable tool/provider boundaries.
 */
export class TurnCheckpointWriter {
  private readonly now: () => number;
  private lastTextLength = 0;
  private lastWrittenAt: number;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(private readonly options: TurnCheckpointWriterOptions) {
    this.now = options.now ?? Date.now;
    this.lastWrittenAt = options.checkpoint.checkpointedAt;
  }

  checkpoint(options: WriteTurnCheckpointOptions = {}): Promise<boolean> {
    const content = this.options.getContent();
    const now = this.now();
    if (!this.shouldWrite(content.text.length, now, options.force === true)) {
      return Promise.resolve(false);
    }

    this.lastTextLength = content.text.length;
    this.lastWrittenAt = now;
    refreshTurnCheckpointPart(this.options.checkpoint, content, now, options);
    const serializedParts = JSON.stringify(content.parts);
    // Checkpointing is best effort: a failed write is logged and swallowed so a
    // transient DB error can neither abort the live turn nor reject every later
    // write chained onto this promise.
    const write = this.pendingWrite
      .then(() =>
        this.options.db
          .updateTable('messages')
          .set({
            text: content.text,
            parts: serializedParts,
            providerState: content.providerState,
            generationTime: content.generationTime,
          })
          .where('id', '=', this.options.messageId)
          .where('isGenerating', '=', 1)
          .execute()
      )
      .then(
        () => true,
        (error: unknown) => {
          logPersistenceError({
            chatId: this.options.chatId,
            error: String(error),
            phase: 'turn_checkpoint',
          });
          return false;
        }
      );
    this.pendingWrite = write.then(() => undefined);
    return write;
  }

  flush(): Promise<void> {
    return this.pendingWrite;
  }

  async prepareFinal(
    status: Exclude<TurnCheckpointStatus, 'active'>,
    reasonCode?: TurnInterruptionReasonCode
  ): Promise<TurnCheckpointContent> {
    await this.pendingWrite;
    const content = this.options.getContent();
    refreshTurnCheckpointPart(this.options.checkpoint, content, this.now(), {
      force: true,
      status,
      reasonCode,
    });
    return content;
  }

  private shouldWrite(textLength: number, now: number, force: boolean): boolean {
    if (force) return true;
    return (
      textLength - this.lastTextLength >= CHECKPOINT_TEXT_INTERVAL_CHARS ||
      now - this.lastWrittenAt >= CHECKPOINT_MAX_INTERVAL_MS
    );
  }
}

export function classifyToolRetrySafety(name: string): ToolRetrySafety {
  if (name.startsWith('mcp__') || name === 'delegate_to_agent') return 'unknown';
  return READ_ONLY_BUILTIN_TOOLS.has(name) ? 'safe_read' : 'confirmation_required';
}

export function createTurnCheckpointPart(input: {
  readonly turnId: string;
  readonly startedAt: number;
  readonly provider: TurnCheckpointPart['provider'];
  readonly modelName: string;
  readonly agentId: TurnCheckpointPart['agentId'];
  readonly agentName?: string;
}): TurnCheckpointPart {
  return {
    type: 'turn_checkpoint',
    version: 1,
    turnId: input.turnId,
    status: 'active',
    sequence: 0,
    startedAt: input.startedAt,
    checkpointedAt: input.startedAt,
    provider: input.provider,
    modelName: input.modelName.slice(0, 256),
    agentId: input.agentId,
    ...(input.agentName ? { agentName: input.agentName.slice(0, 256) } : {}),
    lastAssistantText: '',
    todoSnapshot: [],
    completedCalls: [],
    incompleteCalls: [],
  };
}

export function refreshTurnCheckpointPart(
  checkpoint: TurnCheckpointPart,
  content: TurnCheckpointContent,
  now: number,
  options: WriteTurnCheckpointOptions
): void {
  checkpoint.sequence += 1;
  checkpoint.checkpointedAt = now;
  checkpoint.lastAssistantText = content.text.slice(-TURN_RECOVERY_MAX_TEXT_LENGTH);
  checkpoint.todoSnapshot = getLatestTodoSnapshot(content.parts);
  checkpoint.completedCalls = collectCompletedCalls(content.parts);
  checkpoint.incompleteCalls = collectIncompleteCalls(content.parts);
  if (options.status) checkpoint.status = options.status;
  if (options.reasonCode) checkpoint.reasonCode = options.reasonCode;
  if (checkpoint.status === 'completed') checkpoint.reasonCode = undefined;
}

function getLatestTodoSnapshot(parts: MessagePart[]): TurnCheckpointPart['todoSnapshot'] {
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];
    if (part?.type === 'todo') return part.todos;
  }
  return [];
}

function collectCompletedCalls(parts: MessagePart[]): CompletedToolCall[] {
  const results = new Map<string, Extract<MessagePart, { type: 'tool_result' }>>();
  for (const part of parts) {
    if (part.type === 'tool_result') results.set(part.toolCallId, part);
  }

  const calls: CompletedToolCall[] = [];
  for (const part of parts) {
    if (part.type !== 'tool_call') continue;
    const result = results.get(part.toolCallId);
    if (!result) continue;
    calls.push({
      callId: part.toolCallId.slice(0, 256),
      name: part.name.slice(0, 256),
      retrySafety: classifyToolRetrySafety(part.name),
      result: result.content.slice(0, TURN_RECOVERY_MAX_RESULT_LENGTH),
      ...(result.isError ? { isError: true } : {}),
    });
    if (calls.length >= TURN_RECOVERY_MAX_CALLS) break;
  }
  return calls;
}

function collectIncompleteCalls(parts: MessagePart[]): IncompleteToolCall[] {
  const resultIds = new Set(
    parts.filter((part) => part.type === 'tool_result').map((part) => part.toolCallId)
  );
  const calls: IncompleteToolCall[] = [];
  for (const part of parts) {
    if (part.type !== 'tool_call' || resultIds.has(part.toolCallId)) continue;
    const status = part.execution?.status ?? 'running';
    calls.push({
      callId: part.toolCallId.slice(0, 256),
      name: part.name.slice(0, 256),
      retrySafety: classifyToolRetrySafety(part.name),
      status,
      outcome: resolveIncompleteOutcome(status, part.execution?.reasonCode),
    });
    if (calls.length >= TURN_RECOVERY_MAX_CALLS) break;
  }
  return calls;
}

function resolveIncompleteOutcome(
  status: ToolExecutionStatus,
  reasonCode: ToolExecutionReasonCode | undefined
): IncompleteToolCallOutcome {
  if (status === 'queued') return 'not_started';
  if (reasonCode === 'outcome_unknown') return 'unknown';
  if (isTerminalToolExecutionStatus(status)) return 'interrupted';
  return status === 'running' ? 'unknown' : 'interrupted';
}
