/**
 * The pure part of the adapter: one Codex notification in, neutral events out.
 *
 * Everything stateful about a turn that does *not* need a socket lives here, so
 * the golden-transcript tests can replay a captured real turn straight through
 * this function and assert the exact neutral sequence without spawning anything.
 *
 * Three properties of the observed stream shape this, and getting any of them
 * wrong produces a transcript that looks right until it does not:
 *
 * 1. **Items are correlated by `itemId`, never by position.** They are bracketed
 *    by `item/started` … `item/completed`, deltas arrive between them, and more
 *    than one item can be open at once.
 * 2. **Usage arrives on `thread/tokenUsage/updated`, before `turn/completed`.**
 *    Code that waits for the turn to end and then looks for usage finds nothing.
 * 3. **Reasoning is its own item with its own notifications.** It is never
 *    interleaved into `item/agentMessage/delta`.
 *
 * Unknown notification methods and unknown item types are ignored rather than
 * thrown on. This runtime pins 0.147.0 and will meet newer builds; an additive
 * notification is not a reason to fail a turn.
 */

import type { ExternalAgentEvent, ExternalUsage } from '@mangostudio/shared/external-agents';
import { classifyCodexItem, codexItemId, codexItemStatus, fileChangeDetail } from './items';
import type { AgentMessageDeltaNotification } from './protocol/v2/AgentMessageDeltaNotification';
import type { CommandExecutionOutputDeltaNotification } from './protocol/v2/CommandExecutionOutputDeltaNotification';
import type { ErrorNotification } from './protocol/v2/ErrorNotification';
import type { FileChangePatchUpdatedNotification } from './protocol/v2/FileChangePatchUpdatedNotification';
import type { ItemCompletedNotification } from './protocol/v2/ItemCompletedNotification';
import type { ItemStartedNotification } from './protocol/v2/ItemStartedNotification';
import type { McpToolCallProgressNotification } from './protocol/v2/McpToolCallProgressNotification';
import type { ReasoningSummaryTextDeltaNotification } from './protocol/v2/ReasoningSummaryTextDeltaNotification';
import type { ThreadTokenUsageUpdatedNotification } from './protocol/v2/ThreadTokenUsageUpdatedNotification';
import type { TokenUsageBreakdown } from './protocol/v2/TokenUsageBreakdown';
import type { TurnCompletedNotification } from './protocol/v2/TurnCompletedNotification';

/**
 * How often a still-running activity may report progress.
 *
 * This is a **liveness** interval, not a rendering one. The supervisor cancels a
 * turn that produces no neutral event for its idle timeout, and a `bun test` or
 * a long `git clone` can stream vendor output for minutes without any of the
 * events above ever firing. Coalescing to one update per window keeps the turn
 * demonstrably alive without spending the per-turn payload budget on a build
 * log: the cap is 2 MB for the whole turn, which a raw forward of every delta
 * would exhaust on its own.
 *
 * Comfortably under the supervisor's 60s idle timeout, and the first delta after
 * a quiet window always emits, so a vendor that trickles slower than this is
 * still followed delta for delta rather than batched.
 */
const ACTIVITY_UPDATE_INTERVAL_MS = 5_000;

/** How much of the tail of an activity's output one update carries. */
const ACTIVITY_UPDATE_DETAIL_MAX_CHARS = 2_000;

/** What an open item was classified as, remembered until it completes. */
interface OpenItem {
  readonly disposition: 'text' | 'reasoning' | 'activity' | 'drop';
  /** Text already emitted as deltas, so a completion does not repeat it. */
  emitted: string;
  /** The tail of an activity's own output, kept bounded, for the next update. */
  tail?: string;
  /** True once `tail` dropped anything off its front. */
  tailTruncated?: boolean;
  /** When this item last produced an `activity_updated`. */
  lastUpdateAtMs?: number;
}

export interface CodexTurnReduction {
  readonly events: readonly ExternalAgentEvent[];
  /** True once `turn/completed` for this turn arrived. */
  readonly finished: boolean;
}

const NOTHING: CodexTurnReduction = { events: [], finished: false };

function only(event: ExternalAgentEvent): CodexTurnReduction {
  return { events: [event], finished: false };
}

/**
 * Per-turn reducer state.
 *
 * Scoped to one turn because `turnId` is what every notification carries, and a
 * session may start another turn the moment this one ends. Notifications for a
 * different turn are ignored rather than mixed in.
 */
export class CodexTurnReducer {
  readonly #turnId: string;
  readonly #items = new Map<string, OpenItem>();
  readonly #now: () => number;
  #finished = false;

  constructor(turnId: string, now: () => number = Date.now) {
    this.#turnId = turnId;
    this.#now = now;
  }

  get finished(): boolean {
    return this.#finished;
  }

  /**
   * Reduce one notification.
   *
   * `params` is typed `unknown` because it arrives off a socket. Each branch
   * narrows it to the generated type for that method, which is the only place
   * the vendor's shape is asserted — and the fixture factories build the same
   * generated types, so a shape change fails the build rather than a test.
   */
  reduce(method: string, params: unknown): CodexTurnReduction {
    switch (method) {
      case 'item/started':
        return this.#itemStarted(params as ItemStartedNotification);
      case 'item/completed':
        return this.#itemCompleted(params as ItemCompletedNotification);
      case 'item/agentMessage/delta':
        return this.#textDelta(params as AgentMessageDeltaNotification, 'text_delta');
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        return this.#textDelta(params as ReasoningSummaryTextDeltaNotification, 'reasoning_delta');
      case 'item/commandExecution/outputDelta':
        return this.#activityOutput(params as CommandExecutionOutputDeltaNotification, (p) =>
          p.delta.length > 0 ? p.delta : undefined
        );
      case 'item/mcpToolCall/progress':
        return this.#activityOutput(params as McpToolCallProgressNotification, (p) =>
          p.message.length > 0 ? `${p.message}\n` : undefined
        );
      case 'item/fileChange/patchUpdated':
        return this.#activityOutput(params as FileChangePatchUpdatedNotification, (p) =>
          p.changes.length > 0 ? `${fileChangeDetail(p.changes)}\n` : undefined
        );
      case 'thread/tokenUsage/updated':
        return this.#usage(params as ThreadTokenUsageUpdatedNotification);
      case 'turn/completed':
        return this.#turnCompleted(params as TurnCompletedNotification);
      case 'error':
        return this.#error(params as ErrorNotification);
      default:
        // Includes `item/reasoning/summaryPartAdded`, which marks a boundary
        // between summary parts and carries no text of its own, and every
        // notification family this client opted out of but a future build might
        // still send. Nothing that arrives here may be load-bearing for
        // liveness: the cases above cover every turn-scoped notification a
        // long-running item emits, so a turn that is working is never silent.
        return NOTHING;
    }
  }

  #belongsToTurn(params: { turnId?: string | null }): boolean {
    return params.turnId === this.#turnId;
  }

  #itemStarted(params: ItemStartedNotification): CodexTurnReduction {
    if (!this.#belongsToTurn(params)) return NOTHING;
    const classification = classifyCodexItem(params.item);
    const id = codexItemId(params.item);
    // Nothing coherent to report for an item that cannot be correlated: the
    // deltas and the completion would have no bracket to attach to, and an
    // `activity_started` with no `callId` fails validation and kills the turn.
    if (id === undefined) return NOTHING;
    this.#items.set(id, { disposition: classification.disposition, emitted: '' });
    if (classification.disposition !== 'activity') return NOTHING;
    return only({
      type: 'activity_started',
      callId: id,
      activity: {
        name: classification.name,
        kind: classification.kind,
        title: classification.title,
        ...(classification.detail ? { detail: classification.detail } : {}),
      },
    });
  }

  #itemCompleted(params: ItemCompletedNotification): CodexTurnReduction {
    if (!this.#belongsToTurn(params)) return NOTHING;
    const id = codexItemId(params.item);
    if (id === undefined) return NOTHING;
    const open = this.#items.get(id);
    this.#items.delete(id);
    const classification = classifyCodexItem(params.item);

    if (classification.disposition === 'drop') return NOTHING;

    if (classification.disposition === 'activity') {
      return only({
        type: 'activity_completed',
        callId: id,
        result: {
          status: codexItemStatus(params.item),
          ...(classification.detail ? { detail: classification.detail } : {}),
        },
      });
    }

    // The completion carries the whole text. Anything already streamed as a
    // delta must not be replayed, so only the remainder is emitted — and when
    // the deltas were lossless, that remainder is empty and nothing is sent.
    const emitted = open?.emitted ?? '';
    const full = classification.text;
    const remainder = full.startsWith(emitted) ? full.slice(emitted.length) : full;
    if (remainder.length === 0) return NOTHING;
    return only({
      type: classification.disposition === 'text' ? 'text_delta' : 'reasoning_delta',
      text: remainder,
    });
  }

  #textDelta(
    params: { turnId?: string | null; itemId: string; delta: string },
    type: 'text_delta' | 'reasoning_delta'
  ): CodexTurnReduction {
    if (!this.#belongsToTurn(params)) return NOTHING;
    if (params.delta.length === 0) return NOTHING;
    const open = this.#items.get(params.itemId);
    // A delta may legitimately arrive before this reducer saw `item/started`
    // — on a resumed thread, for instance — so the item is tracked lazily
    // rather than the delta being dropped for lack of a bracket.
    if (open) open.emitted += params.delta;
    else {
      this.#items.set(params.itemId, {
        disposition: type === 'text_delta' ? 'text' : 'reasoning',
        emitted: params.delta,
      });
    }
    return only({ type, text: params.delta });
  }

  /**
   * A running activity said something. Keep the tail, emit at most one update
   * per window.
   *
   * Only items this reducer classified as `activity` produce updates: a delta
   * for an item it never bracketed has no `callId` the hub could attach it to,
   * and inventing one would create a part the transcript then never completes.
   */
  #activityOutput<T extends { turnId?: string | null; itemId: string }>(
    params: T,
    text: (params: T) => string | undefined
  ): CodexTurnReduction {
    if (!this.#belongsToTurn(params)) return NOTHING;
    const open = this.#items.get(params.itemId);
    if (open?.disposition !== 'activity') return NOTHING;
    const chunk = text(params);
    if (chunk === undefined) return NOTHING;

    const combined = (open.tail ?? '') + chunk;
    if (combined.length > ACTIVITY_UPDATE_DETAIL_MAX_CHARS) {
      open.tail = combined.slice(combined.length - ACTIVITY_UPDATE_DETAIL_MAX_CHARS);
      open.tailTruncated = true;
    } else {
      open.tail = combined;
    }

    const now = this.#now();
    const since = now - (open.lastUpdateAtMs ?? Number.NEGATIVE_INFINITY);
    if (since < ACTIVITY_UPDATE_INTERVAL_MS) return NOTHING;
    open.lastUpdateAtMs = now;
    return only({
      type: 'activity_updated',
      callId: params.itemId,
      update: {
        detail: open.tail,
        ...(open.tailTruncated ? { truncated: true } : {}),
      },
    });
  }

  #usage(params: ThreadTokenUsageUpdatedNotification): CodexTurnReduction {
    if (!this.#belongsToTurn(params)) return NOTHING;
    return only({ type: 'usage', usage: mapTokenUsage(params.tokenUsage.last) });
  }

  /**
   * `TurnStatus` has four members and only one of them is success.
   *
   * `interrupted` is the one that is easy to get wrong: it is a terminal status
   * like `completed`, so a check for `failed` alone lets a turn Codex cut short
   * be persisted and shown as a turn that finished saying everything it meant
   * to. It reaches this reducer only for an interruption MangoStudio did **not**
   * ask for — a cancel from here finishes the channel before the notification
   * lands — so the honest report is a non-success terminal, and the neutral
   * vocabulary's non-success terminal is `error`.
   *
   * `inProgress` cannot legitimately arrive on `turn/completed`; treating it as
   * terminal-but-not-successful is the conservative reading.
   */
  #turnCompleted(params: TurnCompletedNotification): CodexTurnReduction {
    if (params.turn.id !== this.#turnId) return NOTHING;
    this.#finished = true;
    if (params.turn.status === 'completed') {
      return { events: [{ type: 'completed' }], finished: true };
    }
    const error = params.turn.error;
    const interrupted = params.turn.status === 'interrupted';
    return {
      events: [
        {
          type: 'error',
          error: {
            code: interrupted ? 'vendor-turn-interrupted' : 'vendor-turn-failed',
            message:
              error?.message ??
              (interrupted ? 'Codex interrupted the turn.' : 'The Codex turn failed.'),
            ...(error?.codexErrorInfo ? { vendorCode: codexErrorCode(error.codexErrorInfo) } : {}),
          },
        },
      ],
      finished: true,
    };
  }

  #error(params: ErrorNotification): CodexTurnReduction {
    if (!this.#belongsToTurn(params)) return NOTHING;
    // `willRetry` means Codex is handling it. Surfacing that as a turn error
    // would show a failure the user is about to see succeed.
    if (params.willRetry) return NOTHING;
    return only({
      type: 'error',
      error: {
        code: 'vendor-error',
        message: params.error.message,
        ...(params.error.codexErrorInfo
          ? { vendorCode: codexErrorCode(params.error.codexErrorInfo) }
          : {}),
        retryable: false,
      },
    });
  }
}

/**
 * `last` rather than `total`.
 *
 * `ThreadTokenUsage` carries both a running thread total and this turn's
 * figures; a per-turn usage event that reported the thread total would grow
 * monotonically and make every turn after the first look enormous.
 */
function mapTokenUsage(breakdown: TokenUsageBreakdown): ExternalUsage {
  return {
    inputTokens: breakdown.inputTokens,
    outputTokens: breakdown.outputTokens,
    cacheReadTokens: breakdown.cachedInputTokens,
    cacheWriteTokens: breakdown.cacheWriteInputTokens,
    reasoningTokens: breakdown.reasoningOutputTokens,
    totalTokens: breakdown.totalTokens,
  };
}

/** `CodexErrorInfo` is a string in most members and a single-key object in the rest. */
export function codexErrorCode(info: unknown): string {
  if (typeof info === 'string') return info;
  if (info && typeof info === 'object') {
    const [key] = Object.keys(info);
    if (key) return key;
  }
  return 'other';
}
