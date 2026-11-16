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
import type { MessagePart } from '@mangostudio/shared/types';
import type { Kysely } from 'kysely';

import { runDurably } from '../../../db/durability';
import type { Database } from '../../../db/types';
import { logPersistenceError } from '../../../services/providers/core/continuation-logger';
import {
  insertCheckpointDelta,
  rewriteCheckpointedRow,
} from '../../messages/infrastructure/message-checkpoint-deltas';
import { type CheckpointPlan, CheckpointPlanner } from './turn-checkpoint-delta';

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

/** How a store commits one checkpoint. */
export interface CheckpointWriteOptions {
  /**
   * Commit at `synchronous = FULL`, so the checkpoint, and every one before it,
   * is on disk when the write resolves even if the machine loses power.
   */
  readonly durable: boolean;
}

/** Where a checkpoint lands. The writer decides what to write; the store only writes it. */
export interface TurnCheckpointStore {
  /**
   * Replaces the message's checkpointed columns with a full snapshot and drops
   * the deltas that predate it, atomically.
   */
  rewriteRow(
    row: {
      readonly text: string;
      readonly partsJson: string;
      readonly providerState: string | null;
      readonly generationTime: string | null | undefined;
    },
    options: CheckpointWriteOptions
  ): Promise<void>;
  /** Adds what changed since the previous checkpoint; `seq` orders the deltas. */
  appendDelta(seq: number, deltaJson: string, options: CheckpointWriteOptions): Promise<void>;
}

export function createDatabaseCheckpointStore(
  db: Kysely<Database>,
  messageId: string
): TurnCheckpointStore {
  return {
    rewriteRow: (row, { durable }) => {
      const write = (conn: Kysely<Database>) => rewriteCheckpointedRow({ messageId, ...row }, conn);
      return durable ? runDurably(db, write) : write(db);
    },
    appendDelta: async (seq, deltaJson, { durable }) => {
      const write = (conn: Kysely<Database>) =>
        insertCheckpointDelta({ messageId, seq, deltaJson }, conn);
      await (durable ? runDurably(db, write) : write(db));
    },
  };
}

interface TurnCheckpointWriterOptions {
  readonly store: TurnCheckpointStore;
  readonly chatId: string;
  readonly messageId: string;
  readonly checkpoint: TurnCheckpointPart;
  readonly getContent: () => TurnCheckpointContent;
  readonly now?: () => number;
  /**
   * Starts `run` on a later macrotask. Best-effort snapshots wait here so deltas
   * that arrive meanwhile share one write. Defaults to `setTimeout(run, 0)`.
   */
  readonly defer?: (run: () => void) => void;
}

export interface WriteTurnCheckpointOptions {
  readonly force?: boolean;
  /**
   * Commit this checkpoint at `synchronous = FULL`. For the one that records a
   * call about to do something the hub cannot take back; see `runDurably`.
   * Implies `force`.
   */
  readonly durable?: boolean;
  readonly status?: TurnCheckpointStatus;
  readonly reasonCode?: TurnInterruptionReasonCode;
}

function deferToMacrotask(run: () => void): void {
  setTimeout(run, 0);
}

/** A checkpoint planned against the live turn, waiting for its turn to be written. */
interface PlannedWrite {
  readonly plan: CheckpointPlan;
  readonly text: string;
  readonly providerState: string | null;
  readonly generationTime: string | null | undefined;
  /** Writes that had failed when this was planned; a delta planned before a later failure has a gap under it. */
  readonly failuresAtPlan: number;
  readonly durable: boolean;
}

/**
 * Orders bounded checkpoint writes for one assistant row.
 *
 * Forced checkpoints (tool and provider boundaries) and `prepareFinal` are
 * required: each is planned when it is called, written in call order, and
 * never replaced. Text-delta checkpoints are best-effort: they only record
 * that the latest state is dirty, and one trailing write plans that state
 * when it starts. A forced write supersedes a dirty best-effort snapshot
 * because it carries newer state.
 *
 * The first checkpoint rewrites the row. Every later one inserts a delta (see
 * {@link CheckpointPlanner}): what the turn added since the previous
 * checkpoint, so the bytes written grow with the turn, not with its square.
 * A failed write drops back to rewriting the row, which does not depend on any
 * earlier checkpoint having landed. Readers fold the deltas over the row
 * (`foldCheckpointDeltasIntoRows`); finalizing the message removes them.
 *
 * @example
 * await writer.checkpoint(); // best-effort: accepted, written on a later tick
 * await writer.checkpoint({ force: true }); // required: resolves once written
 * await writer.flush(); // everything accepted so far is on disk
 */
export class TurnCheckpointWriter {
  private readonly now: () => number;
  private readonly defer: (run: () => void) => void;
  private lastTextLength = 0;
  private lastWrittenAt: number;
  private pendingWrite: Promise<void> = Promise.resolve();
  /** A best-effort snapshot was accepted and no write has taken it yet. */
  private bestEffortDirty = false;
  /**
   * Identifies the trailing best-effort write chained on `pendingWrite` but not
   * started. A required write clears it so the stale task cannot run ahead of it.
   */
  private bestEffortTicket: object | null = null;
  private bestEffortTimerArmed = false;
  private readonly planner = new CheckpointPlanner();
  private nextDeltaSeq = 1;
  private failedWrites = 0;

  constructor(private readonly options: TurnCheckpointWriterOptions) {
    this.now = options.now ?? Date.now;
    this.defer = options.defer ?? deferToMacrotask;
    this.lastWrittenAt = options.checkpoint.checkpointedAt;
  }

  /**
   * Request a checkpoint. A forced call, or one that sets `status` or
   * `reasonCode`, resolves to whether its write landed. A best-effort call resolves to `true` when it passed the throttle and was
   * accepted (it is written later, merged with any newer accepted snapshots,
   * and `flush()` waits for it); `false` means the throttle skipped it.
   */
  checkpoint(options: WriteTurnCheckpointOptions = {}): Promise<boolean> {
    const content = this.options.getContent();
    const now = this.now();
    const durable = options.durable === true;
    const force = options.force === true || durable;
    if (!this.shouldWrite(content.text.length, now, force)) {
      return Promise.resolve(false);
    }

    this.lastTextLength = content.text.length;
    this.lastWrittenAt = now;
    // A status or reason code is state the recovery path reads, so it is never
    // deferred: such a call is written as a required checkpoint even without `force`.
    if (force || options.status !== undefined || options.reasonCode !== undefined) {
      return this.writeRequired(content, now, options);
    }

    // Sequence and timestamp advance per accepted call so the persisted
    // sequence counts checkpoints, however many writes they were merged into.
    advanceTurnCheckpoint(this.options.checkpoint, now);
    this.bestEffortDirty = true;
    this.armBestEffortWrite();
    return Promise.resolve(true);
  }

  /**
   * Resolve once every checkpoint accepted so far, including the trailing
   * best-effort one, is written. A required write queued while this waits
   * supersedes the waiting best-effort task and lands after it, so the wait
   * continues until nothing newer is queued.
   */
  async flush(): Promise<void> {
    if (this.bestEffortDirty) this.queueBestEffortWrite();
    let tail: Promise<void>;
    do {
      tail = this.pendingWrite;
      await tail;
    } while (tail !== this.pendingWrite);
  }

  async prepareFinal(
    status: Exclude<TurnCheckpointStatus, 'active'>,
    reasonCode?: TurnInterruptionReasonCode
  ): Promise<TurnCheckpointContent> {
    await this.flush();
    const content = this.options.getContent();
    refreshTurnCheckpointPart(this.options.checkpoint, content, this.now(), {
      force: true,
      status,
      reasonCode,
    });
    return content;
  }

  private writeRequired(
    content: TurnCheckpointContent,
    now: number,
    options: WriteTurnCheckpointOptions
  ): Promise<boolean> {
    // This write carries state at least as new as any snapshot still waiting.
    this.bestEffortDirty = false;
    this.bestEffortTicket = null;
    advanceTurnCheckpoint(this.options.checkpoint, now);
    applyCheckpointStatus(this.options.checkpoint, options);
    return this.enqueueWrite(this.planWrite(content, options.durable === true));
  }

  private planWrite(content: TurnCheckpointContent, durable = false): PlannedWrite {
    return {
      plan: this.planner.plan(content),
      text: content.text,
      providerState: content.providerState,
      generationTime: content.generationTime,
      failuresAtPlan: this.failedWrites,
      durable,
    };
  }

  private armBestEffortWrite(): void {
    if (this.bestEffortTimerArmed || this.bestEffortTicket) return;
    this.bestEffortTimerArmed = true;
    this.defer(() => {
      this.bestEffortTimerArmed = false;
      if (this.bestEffortDirty) this.queueBestEffortWrite();
    });
  }

  private queueBestEffortWrite(): void {
    if (this.bestEffortTicket) return;
    const ticket = {};
    this.bestEffortTicket = ticket;
    // The snapshot is taken when this write starts, not now: everything accepted
    // while an earlier write was held collapses into this one. It can therefore
    // include parts pushed after the accepted call: newer, consistent state
    // stored under the older `checkpointedAt` and the sequence counted so far.
    this.pendingWrite = this.pendingWrite.then(async () => {
      if (this.bestEffortTicket !== ticket) return;
      this.bestEffortTicket = null;
      if (!this.bestEffortDirty) return;
      this.bestEffortDirty = false;
      await this.writePlanned(this.planWrite(this.options.getContent()));
    });
  }

  private enqueueWrite(planned: PlannedWrite): Promise<boolean> {
    const write = this.pendingWrite.then(() => this.writePlanned(planned));
    this.pendingWrite = write.then(() => undefined);
    return write;
  }

  // Checkpointing is best effort: a failed write is logged and swallowed so a
  // transient DB error can neither abort the live turn nor reject every later
  // write chained onto the queue.
  private async writePlanned(planned: PlannedWrite): Promise<boolean> {
    // An earlier write failed after this delta was planned on top of it, so the
    // delta would leave a gap. Skipping it is safe: the failure already reset the
    // planner, and the next checkpoint rewrites the row.
    if (planned.plan.kind === 'delta' && planned.failuresAtPlan !== this.failedWrites) {
      return false;
    }
    try {
      if (planned.plan.kind === 'rebase') {
        await this.options.store.rewriteRow(
          {
            text: planned.text,
            partsJson: planned.plan.partsJson,
            providerState: planned.providerState,
            generationTime: planned.generationTime,
          },
          { durable: planned.durable }
        );
      } else {
        await this.options.store.appendDelta(this.nextDeltaSeq++, planned.plan.deltaJson, {
          durable: planned.durable,
        });
      }
      return true;
    } catch (error) {
      this.failedWrites += 1;
      this.planner.reset();
      logPersistenceError({
        chatId: this.options.chatId,
        error: String(error),
        phase: 'turn_checkpoint',
      });
      return false;
    }
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
  advanceTurnCheckpoint(checkpoint, now);
  summarizeTurnCheckpointPart(checkpoint, content, options);
}

function advanceTurnCheckpoint(checkpoint: TurnCheckpointPart, now: number): void {
  checkpoint.sequence += 1;
  checkpoint.checkpointedAt = now;
}

function summarizeTurnCheckpointPart(
  checkpoint: TurnCheckpointPart,
  content: TurnCheckpointContent,
  options: WriteTurnCheckpointOptions
): void {
  checkpoint.lastAssistantText = content.text.slice(-TURN_RECOVERY_MAX_TEXT_LENGTH);
  checkpoint.todoSnapshot = getLatestTodoSnapshot(content.parts);
  checkpoint.completedCalls = collectCompletedCalls(content.parts);
  checkpoint.incompleteCalls = collectIncompleteCalls(content.parts);
  applyCheckpointStatus(checkpoint, options);
}

function applyCheckpointStatus(
  checkpoint: TurnCheckpointPart,
  options: WriteTurnCheckpointOptions
): void {
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
