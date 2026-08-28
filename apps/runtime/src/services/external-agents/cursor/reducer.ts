/**
 * The pure part of the adapter: one `session/update` in, neutral events out.
 *
 * Everything stateful about a turn that does *not* need a socket lives here, so
 * the recorded-transcript tests can replay a captured real turn straight through
 * this class and assert the exact neutral sequence without spawning anything.
 *
 * Four properties of the observed stream shape it, and getting any of them
 * wrong produces a transcript that looks right until it does not:
 *
 * 1. **Updates are session-scoped, not turn-scoped.** Unlike Codex, an ACP
 *    notification carries no turn id — only `sessionId`. The adapter is what
 *    knows which turn is live; this reducer is created per turn and only ever
 *    fed while one is running.
 * 2. **Text and reasoning are separate chunk kinds.** `agent_message_chunk` and
 *    `agent_thought_chunk`, each a full content block, never interleaved into
 *    one another.
 * 3. **Tool calls are bracketed by id, and the id is the vendor's.** A
 *    `tool_call` opens, `tool_call_update` carries progress and the terminal
 *    status. More than one can be open at once.
 * 4. **The turn's ending is a *response*, not a notification.** `session/prompt`
 *    resolves with a `stopReason`; nothing on the notification channel says the
 *    turn is over. That is why `finish` exists and why it closes whatever is
 *    still open — otherwise a tool call that never reported a terminal status
 *    leaves a pill spinning in the transcript forever.
 *
 * Unknown `sessionUpdate` variants are ignored rather than thrown on. ACP is
 * versioned independently of Cursor, and an additive variant is not a reason to
 * fail a turn.
 */

import type {
  ExternalActivityStatus,
  ExternalAgentCommand,
  ExternalAgentEvent,
} from '@mangostudio/shared/external-agents';
import type {
  AcpAvailableCommand,
  AcpAvailableCommandsUpdate,
  AcpMessageChunkUpdate,
  AcpPlanUpdate,
  AcpSessionUpdateEnvelope,
  AcpStopReason,
  AcpToolCallUpdate,
} from './protocol';
import {
  activityKindFor,
  activityNameFor,
  detailFields,
  toolCallDetail,
  toolCallOutcome,
  toolCallTitle,
} from './tool-calls';

/**
 * How often a still-running tool call may report progress.
 *
 * A liveness interval, not a rendering one — the same 5s the Codex reducer
 * uses, and for the same reason: the supervisor cancels a turn that produces no
 * neutral event for its 60s idle timeout, while a long build can stream vendor
 * output for minutes. Coalescing keeps the turn demonstrably alive without
 * spending the 2 MB per-turn payload budget on a build log, and the first
 * update after a quiet window always emits.
 */
const ACTIVITY_UPDATE_INTERVAL_MS = 5_000;

/** The synthetic call id for the turn's plan, which ACP sends without one. */
const PLAN_CALL_ID = 'plan';

interface OpenCall {
  /** What the pill was opened as, so a later update does not re-derive it. */
  readonly name: string;
  lastUpdateAtMs?: number;
}

export interface CursorTurnReduction {
  readonly events: readonly ExternalAgentEvent[];
}

const NOTHING: CursorTurnReduction = { events: [] };

function only(event: ExternalAgentEvent): CursorTurnReduction {
  return { events: [event] };
}

export class CursorTurnReducer {
  readonly #now: () => number;
  /**
   * Open tool calls, keyed by the **adapter's** call id rather than the
   * vendor's.
   *
   * Cursor's `toolCallId` is not safe to put on the wire as-is: the live build
   * emits ids like `call-<uuid>-0\nfc_<uuid>_0` — an embedded newline, and 85
   * code points before any growth. The neutral contract bounds a vendor id at
   * 128 code points and *throws* past it, which would fail the turn rather than
   * degrade it. So the vendor id is kept here as the correlation key and a
   * short, stable, per-turn handle is what crosses. Nothing downstream ever
   * echoes a call id back to Cursor — only approval option ids make that trip,
   * and those are passed through untouched — so the substitution costs nothing
   * and removes a class of turn-killing failures.
   */
  readonly #calls = new Map<string, OpenCall>();
  readonly #handles = new Map<string, string>();
  #nextHandle = 1;
  #finished = false;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Reduce one `session/update` payload. */
  reduce(update: unknown): CursorTurnReduction {
    if (!update || typeof update !== 'object') return NOTHING;
    const kind = (update as AcpSessionUpdateEnvelope).sessionUpdate;
    switch (kind) {
      case 'agent_message_chunk':
        return this.#chunk(update as AcpMessageChunkUpdate, 'text_delta');
      case 'agent_thought_chunk':
        return this.#chunk(update as AcpMessageChunkUpdate, 'reasoning_delta');
      case 'tool_call':
        return this.#toolCall(update as AcpToolCallUpdate);
      case 'tool_call_update':
        return this.#toolCallUpdate(update as AcpToolCallUpdate);
      case 'plan':
        return this.#plan(update as AcpPlanUpdate);
      case 'available_commands_update':
        return this.#availableCommands(update as AcpAvailableCommandsUpdate);
      default:
        // Includes `user_message_chunk` (the prompt MangoStudio just sent, which
        // persisting would duplicate in the transcript), `session_info_update`
        // (Cursor's own generated chat title, which is not MangoStudio's title)
        // and `current_mode_update` (an echo of a mode this adapter set). None is
        // load-bearing for liveness: a working turn always produces text,
        // reasoning or tool-call traffic.
        return NOTHING;
    }
  }

  /**
   * The turn ended. Close what is still open, then say how it ended.
   *
   * Open calls are completed with a status derived from the turn rather than
   * assumed successful: a tool call the vendor never reported on did not
   * demonstrably succeed, and a pill that claims it did is a false record.
   */
  finish(stopReason: AcpStopReason | undefined): readonly ExternalAgentEvent[] {
    if (this.#finished) return [];
    this.#finished = true;
    const status = terminalActivityStatus(stopReason);
    const events: ExternalAgentEvent[] = [];
    for (const handle of this.#handles.values()) {
      events.push({ type: 'activity_completed', callId: handle, result: { status } });
    }
    this.#calls.clear();
    this.#handles.clear();

    if (stopReason === 'cancelled') return events;
    if (stopReason === 'end_turn') {
      events.push({ type: 'completed' });
      return events;
    }
    events.push({
      type: 'error',
      error: {
        code: 'vendor-turn-incomplete',
        message: stopReasonMessage(stopReason),
        ...(typeof stopReason === 'string' && stopReason.length > 0
          ? { vendorCode: stopReason }
          : {}),
        retryable: false,
      },
    });
    return events;
  }

  #chunk(
    update: AcpMessageChunkUpdate,
    type: 'text_delta' | 'reasoning_delta'
  ): CursorTurnReduction {
    const text = update.content?.text;
    if (typeof text !== 'string' || text.length === 0) return NOTHING;
    return only({ type, text });
  }

  #handleFor(vendorId: string): string {
    const existing = this.#handles.get(vendorId);
    if (existing) return existing;
    const handle = `cursor-${this.#nextHandle++}`;
    this.#handles.set(vendorId, handle);
    return handle;
  }

  #toolCall(update: AcpToolCallUpdate): CursorTurnReduction {
    const vendorId = update.toolCallId;
    // Nothing coherent to report for a call that cannot be correlated: its
    // updates and its completion would have no bracket to attach to.
    if (typeof vendorId !== 'string' || vendorId.length === 0) return NOTHING;
    if (this.#handles.has(vendorId)) return this.#toolCallUpdate(update);

    const handle = this.#handleFor(vendorId);
    const name = activityNameFor(update.kind);
    this.#calls.set(vendorId, { name });
    const detail = toolCallDetail(update.content, update.rawInput);
    return only({
      type: 'activity_started',
      callId: handle,
      activity: {
        name,
        kind: activityKindFor(update.kind),
        title: toolCallTitle(update),
        ...detailFields(detail),
      },
    });
  }

  #toolCallUpdate(update: AcpToolCallUpdate): CursorTurnReduction {
    const vendorId = update.toolCallId;
    if (typeof vendorId !== 'string' || vendorId.length === 0) return NOTHING;
    // A first sighting through the update channel: ACP allows a `tool_call_update`
    // for a call this client never saw open — on a loaded session, for instance
    // — and dropping it would lose the whole call rather than its bracket.
    const open = this.#calls.get(vendorId);
    if (!open) return this.#toolCall({ ...update, sessionUpdate: 'tool_call' });

    const handle = this.#handleFor(vendorId);
    const outcome = toolCallOutcome(update.status);
    const detail = toolCallDetail(update.content, update.rawOutput ?? update.rawInput);

    if (outcome) {
      this.#calls.delete(vendorId);
      this.#handles.delete(vendorId);
      return only({
        type: 'activity_completed',
        callId: handle,
        result: { status: outcome, ...detailFields(detail) },
      });
    }

    if (!detail) return NOTHING;
    const now = this.#now();
    const since = now - (open.lastUpdateAtMs ?? Number.NEGATIVE_INFINITY);
    if (since < ACTIVITY_UPDATE_INTERVAL_MS) return NOTHING;
    open.lastUpdateAtMs = now;
    return only({
      type: 'activity_updated',
      callId: handle,
      update: detailFields(detail),
    });
  }

  /**
   * The agent's plan, rendered as one long-lived activity.
   *
   * ACP sends the whole list on every change and gives it no id, so it is
   * bracketed under a synthetic one and updated in place rather than emitting a
   * new pill per revision. It closes with the turn, like any other open call.
   */
  /**
   * The session's slash-command catalog.
   *
   * Passed through as the vendor wrote it, including the `(user)`,
   * `(global)` and `(builtin skill)` suffixes Cursor appends to a description.
   * Those are the vendor's own words about where a command came from, and
   * parsing them into a typed provenance field would be reading tea leaves: the
   * suffix is a rendering choice, not a contract, and it would break silently
   * the first time Cursor rephrases it.
   *
   * An empty catalog is emitted rather than swallowed. "This session has no
   * commands" is an answer the composer can act on; dropping it would leave the
   * palette showing a stale list from whatever ran before.
   */
  #availableCommands(update: AcpAvailableCommandsUpdate): CursorTurnReduction {
    if (!Array.isArray(update.availableCommands)) return NOTHING;
    const commands: ExternalAgentCommand[] = [];
    for (const entry of update.availableCommands as readonly AcpAvailableCommand[]) {
      if (!entry || typeof entry !== 'object') continue;
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      if (name.length === 0) continue;
      const description = typeof entry.description === 'string' ? entry.description.trim() : '';
      commands.push({ name, ...(description.length > 0 ? { description } : {}) });
    }
    return only({ type: 'commands_available', commands });
  }

  #plan(update: AcpPlanUpdate): CursorTurnReduction {
    const entries = update.entries ?? [];
    const detail = entries
      .map((entry) => (entry.status ? `[${entry.status}] ${entry.content ?? ''}` : entry.content))
      .filter((line): line is string => typeof line === 'string' && line.length > 0)
      .join('\n');
    if (detail.length === 0) return NOTHING;

    const title = `${entries.length} step${entries.length === 1 ? '' : 's'}`;
    if (!this.#calls.has(PLAN_CALL_ID)) {
      const handle = this.#handleFor(PLAN_CALL_ID);
      this.#calls.set(PLAN_CALL_ID, { name: 'plan' });
      return only({
        type: 'activity_started',
        callId: handle,
        activity: { name: 'plan', kind: 'plan', title, detail },
      });
    }
    return only({
      type: 'activity_updated',
      callId: this.#handleFor(PLAN_CALL_ID),
      update: { title, detail },
    });
  }
}

function terminalActivityStatus(stopReason: AcpStopReason | undefined): ExternalActivityStatus {
  if (stopReason === 'cancelled') return 'cancelled';
  return stopReason === 'end_turn' ? 'completed' : 'failed';
}

function stopReasonMessage(stopReason: AcpStopReason | undefined): string {
  switch (stopReason) {
    case 'max_tokens':
      return 'Cursor stopped the turn at its token limit.';
    case 'max_turn_requests':
      return 'Cursor stopped the turn at its request limit.';
    case 'refusal':
      return 'Cursor refused to continue this turn.';
    default:
      return stopReason
        ? `Cursor ended the turn with "${stopReason}".`
        : 'Cursor ended the turn without saying why.';
  }
}
