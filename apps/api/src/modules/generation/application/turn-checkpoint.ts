import {
  isTerminalToolExecutionStatus,
  type ToolExecutionReasonCode,
  type ToolExecutionStatus,
} from '@mangostudio/shared/tool-executions';
import {
  type CompletedToolCall,
  type IncompleteToolCall,
  type IncompleteToolCallOutcome,
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
import { CHECKPOINT_MAX_INTERVAL_MS, CHECKPOINT_TEXT_INTERVAL_CHARS } from './checkpoint-cadence';
import { heldTailDelay, type HeldTailScheduler, HeldTailTimer } from './held-tail-timer';
import { classifyToolRetrySafety } from './tool-retry-safety';
import { type CheckpointPlan, CheckpointPlanner } from './turn-checkpoint-delta';

export { CHECKPOINT_MAX_INTERVAL_MS, CHECKPOINT_TEXT_INTERVAL_CHARS };

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

/**
 * Stores checkpoints in the message row. Both writes only touch a row that is
 * still generating, so one for a message that was already finalized stores
 * nothing. A best-effort checkpoint that loses that race is harmless and stays
 * silent. A durable one is a write-ahead record the caller is about to act on, so
 * it throws rather than report a marker that was never stored.
 */
export function createDatabaseCheckpointStore(
  db: Kysely<Database>,
  messageId: string
): TurnCheckpointStore {
  const requireStored = (stored: boolean, durable: boolean, write: string) => {
    if (!stored && durable) {
      throw new Error(
        `durable checkpoint ${write} for message ${messageId} stored nothing | expected a generating message row`
      );
    }
  };
  return {
    rewriteRow: async (row, { durable }) => {
      const write = (conn: Kysely<Database>) => rewriteCheckpointedRow({ messageId, ...row }, conn);
      const stored = await (durable ? runDurably(db, 'turn_checkpoint_rewrite', write) : write(db));
      requireStored(stored, durable, 'rewrite');
    },
    appendDelta: async (seq, deltaJson, { durable }) => {
      const write = (conn: Kysely<Database>) =>
        insertCheckpointDelta({ messageId, seq, deltaJson }, conn);
      const stored = await (durable ? runDurably(db, 'turn_checkpoint_delta', write) : write(db));
      requireStored(stored, durable, 'delta');
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
  /**
   * Starts the timer that writes a tail the throttle held back once the time
   * window since the last accepted write has run out. Defaults to an unref'd
   * `setTimeout`.
   */
  readonly scheduleHeldTail?: HeldTailScheduler;
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
  readonly providerState: string | null;
  readonly generationTime: string | null | undefined;
  /** Writes that had failed when this was planned; a delta planned before a later failure has a gap under it. */
  readonly failuresAtPlan: number;
  /**
   * Durable rewrites that had been planned again when this was planned. A re-planned
   * rewrite carries the live turn as it was when it ran, which includes everything
   * planned before it, so such a write is superseded.
   */
  readonly replansAtPlan: number;
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
 * The throttle only runs when a delta arrives. A call it skips arms one trailing
 * timer for the rest of the time window since the last accepted write; if no
 * delta is accepted first, the timer writes the held tail, so a provider stall
 * leaves at most about a second of text unwritten. Every accepted write cancels
 * the timer, and `flush()`, `prepareFinal()` and `close()` cancel it for good.
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
  private readonly heldTail: HeldTailTimer;
  private readonly planner = new CheckpointPlanner();
  private nextDeltaSeq = 1;
  private failedWrites = 0;
  private replannedRewrites = 0;

  constructor(private readonly options: TurnCheckpointWriterOptions) {
    this.now = options.now ?? Date.now;
    this.defer = options.defer ?? deferToMacrotask;
    this.heldTail = new HeldTailTimer(options.scheduleHeldTail);
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
      // Skipped, not dropped: if the provider goes quiet no later call arrives to
      // accept it, so a timer writes it when the time window runs out.
      this.heldTail.arm(heldTailDelay(this.lastWrittenAt, now, CHECKPOINT_MAX_INTERVAL_MS), () =>
        this.writeHeldTail()
      );
      return Promise.resolve(false);
    }

    this.lastTextLength = content.text.length;
    this.lastWrittenAt = now;
    // Whatever the timer was holding is part of this write.
    this.heldTail.cancel();
    // A status or reason code is state the recovery path reads, so it is never
    // deferred: such a call is written as a required checkpoint even without `force`.
    if (force || options.status !== undefined || options.reasonCode !== undefined) {
      return this.writeRequired(content, now, options);
    }

    this.acceptBestEffort(now);
    return Promise.resolve(true);
  }

  /**
   * Stops the held-tail timer for good. The turn is ending: nothing is written
   * on a timer after this. `prepareFinal` calls it; call it directly on a path
   * that ends the turn without one.
   */
  close(): void {
    this.heldTail.close();
  }

  /**
   * Resolve once every checkpoint accepted so far, including the trailing
   * best-effort one, is written. A required write queued while this waits
   * supersedes the waiting best-effort task and lands after it, so the wait
   * continues until nothing newer is queued. It does not write a tail the
   * throttle skipped: it cancels the timer that would, since the caller is
   * about to write the complete state itself.
   */
  async flush(): Promise<void> {
    this.heldTail.cancel();
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
    // Closed before the flush so no timer can write between it and the final row.
    this.close();
    await this.flush();
    const content = this.options.getContent();
    refreshTurnCheckpointPart(this.options.checkpoint, content, this.now(), {
      force: true,
      status,
      reasonCode,
    });
    return content;
  }

  /** Accepts a best-effort snapshot: it is written later, merged with any newer accepted ones. */
  private acceptBestEffort(now: number): void {
    // Sequence and timestamp advance per accepted call so the persisted
    // sequence counts checkpoints, however many writes they were merged into.
    advanceTurnCheckpoint(this.options.checkpoint, now);
    this.bestEffortDirty = true;
    this.armBestEffortWrite();
  }

  /** The held-tail timer fired: no accepted write superseded the tail the throttle skipped. */
  private writeHeldTail(): void {
    const now = this.now();
    this.lastTextLength = this.options.getContent().text.length;
    this.lastWrittenAt = now;
    this.acceptBestEffort(now);
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
      providerState: content.providerState,
      generationTime: content.generationTime,
      failuresAtPlan: this.failedWrites,
      replansAtPlan: this.replannedRewrites,
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
  private async writePlanned(queued: PlannedWrite): Promise<boolean> {
    let planned = queued;
    // Two things make a queued write unsafe to write as planned:
    //  - An earlier write failed after this delta was planned on top of it, so the
    //    delta would leave a gap.
    //  - A durable write was planned again after this one was planned. That rewrite
    //    holds the live turn as of when it ran, so a delta planned before it would be
    //    folded over content that already contains its text, and a rewrite planned
    //    before it would put older content back.
    // An ordinary checkpoint is skipped in both cases: the next one rewrites the row
    // or follows the re-planned one. A durable one (the record that a tool call or a
    // paid image is under way) must not be dropped, as a full rewrite never was: it is
    // planned again against the live turn as a rewrite that nothing earlier has to
    // have landed for. Planning it again supersedes whatever was planned before it.
    const gap = planned.plan.kind === 'delta' && planned.failuresAtPlan !== this.failedWrites;
    const superseded = planned.replansAtPlan !== this.replannedRewrites;
    if (gap || superseded) {
      if (!planned.durable) return false;
      this.replannedRewrites += 1;
      this.planner.reset();
      planned = this.planWrite(this.options.getContent(), true);
    }
    try {
      if (planned.plan.kind === 'rebase') {
        await this.options.store.rewriteRow(
          {
            text: planned.plan.text,
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
