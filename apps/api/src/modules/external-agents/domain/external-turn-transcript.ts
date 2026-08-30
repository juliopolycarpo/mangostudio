/**
 * What one external turn looks like on disk, built event by event.
 *
 * Pure: no database, no runtime client, no clock of its own. It takes ordered
 * events and produces the assistant message's text and parts, so that the
 * question "does a killed consumer leave a readable prefix?" is answered by a
 * unit test rather than by an integration run.
 *
 * The vendor's output never becomes a MangoStudio `tool_call`. Activity lands on
 * `external_activity`, approvals on `external_approval`, and the turn's own
 * record on `external_turn` — three types the tool executor, the re-run
 * affordances and the budget accounting have no case for.
 */

import type {
  ExternalAgentError,
  ExternalAgentEvent,
  ExternalAgentTargetId,
  ExternalApprovalRequest,
  ExternalSteerRejectionReason,
  ExternalTurnTerminalReason,
  ExternalUsage,
} from '@mangostudio/shared/external-agents';
import {
  EXTERNAL_TURN_MAX_EVENTS,
  EXTERNAL_TURN_PAYLOAD_MAX_BYTES,
} from '@mangostudio/shared/external-agents';
import type {
  ExternalActivityPart,
  ExternalApprovalPart,
  ExternalSteerPart,
  ExternalTurnPart,
  MessagePart,
} from '@mangostudio/shared/types';

export interface ExternalTurnTranscriptOptions {
  readonly targetId: ExternalAgentTargetId;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly maxBytes?: number;
  readonly maxEvents?: number;
}

/** What the caller has to act on after one event was applied. */
export interface ExternalTranscriptApplication {
  /** Write now rather than at the throttled cadence: something durable happened. */
  readonly durable: boolean;
  /** Set when this event ended the turn. */
  readonly terminal?: ExternalTurnTerminalReason;
  /** Set when the vendor asked a question only the registry may answer. */
  readonly approvalRequested?: ExternalApprovalRequest;
  /** Set when the vendor resolved one of its own requests. */
  readonly approvalResolved?: string;
}

/**
 * Accumulates one turn. Sequencing, dedup and gap detection happen before this;
 * everything reaching {@link ExternalTurnTranscript.apply} is an event that has
 * already been decided to belong to this turn, exactly once.
 */
export class ExternalTurnTranscript {
  readonly #parts: MessagePart[] = [];
  readonly #turnPart: ExternalTurnPart;
  readonly #activityByCallId = new Map<string, ExternalActivityPart>();
  readonly #approvalByRequestId = new Map<string, ExternalApprovalPart>();
  readonly #steerByClientMessageId = new Map<string, ExternalSteerPart>();
  readonly #maxBytes: number;
  readonly #maxEvents: number;
  #text = '';
  #terminated = false;

  constructor(options: ExternalTurnTranscriptOptions) {
    this.#maxBytes = options.maxBytes ?? EXTERNAL_TURN_PAYLOAD_MAX_BYTES;
    this.#maxEvents = options.maxEvents ?? EXTERNAL_TURN_MAX_EVENTS;
    this.#turnPart = {
      type: 'external_turn',
      version: 1,
      targetId: options.targetId,
      sessionId: options.sessionId,
      status: 'active',
      startedAt: options.startedAt,
      updatedAt: options.startedAt,
      lastSequence: 0,
      eventCount: 0,
      persistedBytes: 0,
    };
    // First, so a transcript is never a bare text blob with no record of who
    // produced it — including the one written before any event arrives.
    this.#parts.push(this.#turnPart);
  }

  /** The assistant message's `text` column: the vendor's prose, nothing else. */
  get text(): string {
    return this.#text;
  }

  get parts(): MessagePart[] {
    return this.#parts;
  }

  get turnPart(): ExternalTurnPart {
    return this.#turnPart;
  }

  get usage(): ExternalUsage | undefined {
    return this.#turnPart.usage;
  }

  get terminated(): boolean {
    return this.#terminated;
  }

  bindNativeTurn(nativeTurnId: string): void {
    this.#turnPart.nativeTurnId = nativeTurnId;
  }

  apply(
    event: ExternalAgentEvent,
    context: { readonly sequence: number; readonly at: number }
  ): ExternalTranscriptApplication {
    // Observational vendor state is streamed to the hub for display/cache only.
    // It must not consume transcript event/byte budgets or be able to terminate
    // the turn — the contract treats these as non-durable no-ops.
    if (
      event.type === 'thread_usage' ||
      event.type === 'account_limits' ||
      // A slash-command catalog is the same shape of thing: streamed for the
      // composer's palette, persisted nowhere. Charging it would let a vendor
      // that re-announces mid-turn spend a turn's budget on a menu.
      event.type === 'commands_available'
    ) {
      return { durable: false };
    }

    this.#turnPart.lastSequence = context.sequence;
    this.#turnPart.updatedAt = context.at;
    this.#turnPart.eventCount += 1;
    this.#turnPart.persistedBytes += byteLengthOf(event);

    if (this.#budgetExceeded()) {
      // Applied first, then terminated: the event that crossed the line is
      // already paid for, and keeping it makes the transcript's last visible
      // state match the recorded byte count. The event may itself have been
      // terminal, in which case `finalize` keeps that first reason — so the
      // reported one is read back off the record rather than assumed, or the
      // caller would report a limit on a turn the transcript says completed.
      const application = this.#applyEvent(event, context.at);
      this.finalize('limit-exceeded', context.at);
      return { ...application, durable: true, terminal: this.#turnPart.terminalReason };
    }

    return this.#applyEvent(event, context.at);
  }

  /**
   * Writes the terminal state onto the turn record. Idempotent — the first
   * terminal writer wins, so a cancel racing a vendor's own completion cannot
   * rewrite what already happened.
   */
  finalize(reason: ExternalTurnTerminalReason, at: number): void {
    if (this.#terminated) return;
    this.#terminated = true;
    // Order matters: a cancelled turn can end with an empty thinking part
    // trailing. Dropping it first means the mark below lands on whatever is
    // trailing *after* that — never on a part this same call is about to
    // delete, which would leave the live projection (whose identical rule
    // runs in the same order) disagreeing with this one about which part, if
    // any, carries the marker.
    this.#dropTrailingEmptyThinking();
    if (reason !== 'completed') this.#markTrailingIncomplete();
    this.#turnPart.status = 'terminal';
    this.#turnPart.terminalReason = reason;
    this.#turnPart.updatedAt = at;
  }

  /**
   * `display: "omitted"` is the API default on current models, so a reasoning
   * phase that opened via `reasoning_started` and never received a single
   * `thinking_delta` is the common case, not the exception. Left alone, every
   * such turn would persist a completed, permanently empty collapsed
   * "Thinking" block — sealing a block a live render only ever showed as a
   * transient pulse. Only the trailing part qualifies: an empty `thinking`
   * part earlier in the transcript is real history that interleaved activity
   * already closed.
   */
  #dropTrailingEmptyThinking(): void {
    const last = this.#parts.at(-1);
    if (last?.type === 'thinking' && last.text.length === 0) this.#parts.pop();
  }

  /**
   * Marks the trailing prose as cut short, for any terminal reason but
   * `completed`. No vendor event describes a sentence stopping mid-thought,
   * so this is the cheapest source that is still correct: it needs no vendor
   * data and covers all nine terminal reasons, including ones no adapter has
   * a more specific signal for.
   */
  #markTrailingIncomplete(): void {
    const last = this.#parts.at(-1);
    if (last && (last.type === 'text' || last.type === 'thinking')) last.incomplete = true;
  }

  /**
   * Marks an approval dead on the transcript. A card that outlived its turn must
   * render as expired rather than as a control nobody can answer.
   */
  resolveApproval(
    requestId: string,
    decision: {
      readonly optionId?: string;
      readonly source: NonNullable<ExternalApprovalPart['decisionSource']>;
      readonly at: number;
    }
  ): void {
    const part = this.#approvalByRequestId.get(requestId);
    if (!part || part.decisionSource !== undefined) return;
    if (decision.optionId !== undefined) part.decision = decision.optionId;
    part.decisionSource = decision.source;
    part.resolvedAt = decision.at;
  }

  /** Every approval this turn asked for that nobody has answered yet. */
  pendingApprovalIds(): readonly string[] {
    return [...this.#approvalByRequestId.values()]
      .filter((part) => part.decisionSource === undefined)
      .map((part) => part.requestId);
  }

  recordError(error: ExternalAgentError): void {
    this.#turnPart.error = error;
  }

  /**
   * Records that a steer was sent, before the vendor call it feeds is made.
   *
   * Deliberately outside {@link apply}: a steer is the user talking to the
   * turn, not the vendor reporting something, so there is no envelope
   * sequence to advance — the caller has already decided this write is
   * happening before it knows whether the vendor will honour it. `status`
   * starts `'accepted'` optimistically; {@link resolveSteerRejected} corrects
   * it in place if the vendor call comes back refused. The text itself never
   * changes either way.
   *
   * Charged against the same byte and event budget {@link apply} enforces,
   * because the caller accepts an unbounded number of these — without a
   * charge, steering would be a second, uncapped way to grow the very message
   * `EXTERNAL_TURN_PAYLOAD_MAX_BYTES` exists to bound. Applied first, then
   * checked, exactly like `apply`: the attempt that crosses the line is kept,
   * so the transcript's recorded byte count still matches what it holds.
   */
  recordSteerAttempt(
    input: { readonly clientMessageId: string; readonly text: string },
    at: number
  ): { readonly terminal?: ExternalTurnTerminalReason } {
    const part: ExternalSteerPart = {
      type: 'external_steer',
      targetId: this.#turnPart.targetId,
      clientMessageId: input.clientMessageId,
      text: input.text,
      status: 'accepted',
      createdAt: at,
    };
    this.#steerByClientMessageId.set(input.clientMessageId, part);
    this.#parts.push(part);
    this.#turnPart.eventCount += 1;
    this.#turnPart.persistedBytes += Buffer.byteLength(input.text);
    this.#turnPart.updatedAt = at;

    if (this.#budgetExceeded()) {
      this.finalize('limit-exceeded', at);
      return { terminal: 'limit-exceeded' };
    }
    return {};
  }

  /** Corrects an already-recorded steer to `'rejected'`. A no-op once corrected. */
  resolveSteerRejected(clientMessageId: string, reasonCode: ExternalSteerRejectionReason): void {
    const part = this.#steerByClientMessageId.get(clientMessageId);
    if (!part || part.status === 'rejected') return;
    part.status = 'rejected';
    part.reasonCode = reasonCode;
  }

  #budgetExceeded(): boolean {
    return (
      this.#turnPart.persistedBytes > this.#maxBytes || this.#turnPart.eventCount > this.#maxEvents
    );
  }

  #applyEvent(event: ExternalAgentEvent, at: number): ExternalTranscriptApplication {
    switch (event.type) {
      case 'session_started':
        // The vendor's own session handle is server-owned state, not transcript.
        // Persisting it here would put a resumable identifier in front of every
        // client that can read the chat.
        return { durable: false };

      case 'commands_available':
        // What the user may type next, not what the agent said. Persisting it
        // would replay a catalog into a reloaded transcript long after the
        // session that announced it stopped existing. Unreachable — `apply`
        // exempts it above, the way it does `thread_usage` — but the switch is
        // the union's exhaustiveness check and every member has to name itself.
        return { durable: false };

      case 'text_delta':
        this.#text += event.text;
        this.#appendText('text', event.text);
        return { durable: false };

      case 'reasoning_delta':
        this.#appendText('thinking', event.text);
        return { durable: false };

      case 'reasoning_started':
        // Opens the block a reload has to show too, the way `reduceThinkingStart`
        // does for an internal turn. `#appendText` already coalesces onto an
        // existing trailing `thinking` part, so a block that already received
        // text is untouched; `finalize` drops one that received none.
        this.#appendText('thinking', '');
        return { durable: false };

      case 'activity_started': {
        const part: ExternalActivityPart = {
          type: 'external_activity',
          targetId: this.#turnPart.targetId,
          callId: event.callId,
          name: event.activity.name,
          kind: event.activity.kind,
          title: event.activity.title,
          ...(event.activity.detail !== undefined ? { detail: event.activity.detail } : {}),
          status: 'running',
          ...(event.activity.truncated ? { truncated: true } : {}),
        };
        this.#activityByCallId.set(event.callId, part);
        this.#parts.push(part);
        return { durable: true };
      }

      case 'activity_updated': {
        const part = this.#activityByCallId.get(event.callId);
        if (!part) return { durable: false };
        if (event.update.title !== undefined) part.title = event.update.title;
        if (event.update.detail !== undefined) part.detail = event.update.detail;
        if (event.update.truncated) part.truncated = true;
        return { durable: false };
      }

      case 'activity_completed': {
        const part = this.#activityByCallId.get(event.callId);
        if (!part) return { durable: false };
        part.status = event.result.status;
        if (event.result.detail !== undefined) part.detail = event.result.detail;
        if (event.result.truncated) part.truncated = true;
        if (event.result.status === 'failed') part.isError = true;
        return { durable: true };
      }

      case 'approval_requested': {
        const part: ExternalApprovalPart = {
          type: 'external_approval',
          targetId: this.#turnPart.targetId,
          requestId: event.request.requestId,
          kind: event.request.kind,
          title: event.request.title,
          ...(event.request.detail !== undefined ? { detail: event.request.detail } : {}),
          // The vendor's option set, in the vendor's order, untouched.
          options: event.request.options,
          expiresAtMs: event.request.expiresAtMs,
          ...(event.request.truncated ? { truncated: true } : {}),
        };
        this.#approvalByRequestId.set(event.request.requestId, part);
        this.#parts.push(part);
        return { durable: true, approvalRequested: event.request };
      }

      case 'approval_resolved':
        this.resolveApproval(event.requestId, {
          optionId: event.decision.optionId,
          source: event.decision.source,
          at,
        });
        return { durable: true, approvalResolved: event.requestId };

      case 'usage':
        // Sparse by design: adapters report only what their vendor reports, and
        // a later event that omits a field must not erase an earlier value.
        this.#turnPart.usage = { ...this.#turnPart.usage, ...event.usage };
        return { durable: false };

      case 'thread_usage':
        // Cumulative scope is chat-level display state, not a durable turn part.
        return { durable: false };

      case 'account_limits':
        // Account quota is cached vendor state, not transcript.
        return { durable: false };

      case 'completed':
        this.finalize('completed', at);
        return { durable: true, terminal: 'completed' };

      case 'error':
        this.recordError(event.error);
        this.finalize('vendor-error', at);
        return { durable: true, terminal: 'vendor-error' };
    }
  }

  /**
   * Appends to the trailing part when it is already of this kind, so a stream of
   * deltas is one block rather than thousands, and interleaved activity still
   * splits the prose where the vendor split it.
   */
  #appendText(kind: 'text' | 'thinking', text: string): void {
    const last = this.#parts.at(-1);
    if (last?.type === kind) {
      last.text += text;
      return;
    }
    this.#parts.push(kind === 'text' ? { type: 'text', text } : { type: 'thinking', text });
  }
}

function byteLengthOf(event: ExternalAgentEvent): number {
  return Buffer.byteLength(JSON.stringify(event));
}
