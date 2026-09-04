import { describe, expect, it } from 'bun:test';
import type { ExternalAgentEvent } from '@mangostudio/shared/external-agents';
import type { ExternalActivityPart, ExternalApprovalPart } from '@mangostudio/shared/types';
import { ExternalTurnTranscript } from '../../../../src/modules/external-agents/domain/external-turn-transcript';

function transcript(overrides: { maxBytes?: number; maxEvents?: number } = {}) {
  return new ExternalTurnTranscript({
    targetId: 'codex',
    sessionId: 'session-1',
    startedAt: 1_000,
    ...overrides,
  });
}

function feed(
  target: ExternalTurnTranscript,
  events: readonly ExternalAgentEvent[],
  startSequence = 1
) {
  return events.map((event, index) =>
    target.apply(event, { sequence: startSequence + index, at: 2_000 + index })
  );
}

const APPROVAL: Extract<ExternalAgentEvent, { type: 'approval_requested' }> = {
  type: 'approval_requested',
  request: {
    requestId: 'req-1',
    kind: 'command',
    title: 'Run rm -rf build',
    options: [
      { id: 'approve', isDestructive: false },
      { id: 'deny', isDestructive: true },
    ],
    expiresAtMs: 9_999,
  },
};

describe('ExternalTurnTranscript', () => {
  it('opens with the turn record so a transcript always names its owner', () => {
    const parts = transcript().parts;

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      type: 'external_turn',
      targetId: 'codex',
      sessionId: 'session-1',
      status: 'active',
    });
  });

  it('accumulates prose into one block and keeps reasoning separate', () => {
    const target = transcript();
    feed(target, [
      { type: 'text_delta', text: 'Hello ' },
      { type: 'text_delta', text: 'world' },
      { type: 'reasoning_delta', text: 'thinking' },
      { type: 'text_delta', text: '!' },
    ]);

    expect(target.text).toBe('Hello world!');
    expect(target.parts.map((part) => part.type)).toEqual([
      'external_turn',
      'text',
      'thinking',
      'text',
    ]);
  });

  it('opens an empty thinking part when a reasoning phase starts', () => {
    const target = transcript();
    feed(target, [{ type: 'reasoning_started' }]);

    expect(target.parts.map((part) => part.type)).toEqual(['external_turn', 'thinking']);
    expect(target.parts.at(-1)).toMatchObject({ type: 'thinking', text: '' });
  });

  /**
   * `display: "omitted"` is the API default on current models, so a reasoning
   * phase producing zero characters is the common case. Left sealed, a reload
   * would show a completed, permanently empty collapsed block for every
   * ordinary turn — not a bug the user did anything to cause.
   */
  it('drops a trailing reasoning phase that received no text once the turn ends', () => {
    const target = transcript();
    feed(target, [{ type: 'reasoning_started' }, { type: 'completed' }]);

    expect(target.parts.map((part) => part.type)).toEqual(['external_turn']);
  });

  it('keeps a reasoning phase that received text, even though the block started empty', () => {
    const target = transcript();
    feed(target, [
      { type: 'reasoning_started' },
      { type: 'reasoning_delta', text: 'weighing it' },
      { type: 'completed' },
    ]);

    expect(target.parts.map((part) => part.type)).toEqual(['external_turn', 'thinking']);
    expect(target.parts.at(-1)).toMatchObject({ type: 'thinking', text: 'weighing it' });
  });

  /**
   * The vendor closing an empty phase is a statement that it was withheld, not
   * that it is still running — so it goes at that moment, wherever it sits.
   * Position never enters into it: a blank collapsed block in the middle of a
   * transcript is exactly as unreadable as one at the end.
   */
  it('drops an empty reasoning phase the vendor closed, mid-transcript', () => {
    const target = transcript();
    feed(target, [
      { type: 'reasoning_started' },
      { type: 'reasoning_ended' },
      {
        type: 'activity_started',
        callId: 'call-1',
        activity: { name: 'shell', kind: 'command', title: 'ls' },
      },
      { type: 'completed' },
    ]);

    expect(target.parts.map((part) => part.type)).toEqual(['external_turn', 'external_activity']);
  });

  it('keeps a closed reasoning phase that received text', () => {
    const target = transcript();
    feed(target, [
      { type: 'reasoning_started' },
      { type: 'reasoning_delta', text: 'weighing it' },
      { type: 'reasoning_ended' },
      { type: 'text_delta', text: 'here it is' },
      { type: 'completed' },
    ]);

    expect(target.parts.map((part) => part.type)).toEqual(['external_turn', 'thinking', 'text']);
  });

  it('records activity as external_activity, never as a tool call', () => {
    const target = transcript();
    feed(target, [
      {
        type: 'activity_started',
        callId: 'call-1',
        activity: { name: 'shell', kind: 'command', title: 'ls -la' },
      },
      { type: 'activity_updated', callId: 'call-1', update: { detail: 'running' } },
      { type: 'activity_completed', callId: 'call-1', result: { status: 'failed' } },
    ]);

    const activity = target.parts.find(
      (part): part is ExternalActivityPart => part.type === 'external_activity'
    );
    expect(activity).toMatchObject({
      callId: 'call-1',
      name: 'shell',
      detail: 'running',
      status: 'failed',
      isError: true,
    });
    expect(target.parts.some((part) => part.type === 'tool_call')).toBe(false);
    expect(target.parts.some((part) => part.type === 'tool_result')).toBe(false);
  });

  it('keeps the vendor option set untouched and reports the request to its caller', () => {
    const target = transcript();
    const [application] = feed(target, [APPROVAL]);

    expect(application?.approvalRequested?.requestId).toBe('req-1');
    const approval = target.parts.find(
      (part): part is ExternalApprovalPart => part.type === 'external_approval'
    );
    expect(approval?.options).toEqual(APPROVAL.request.options);
    expect(approval?.decisionSource).toBeUndefined();
  });

  it('marks an outstanding approval expired without inventing a chosen option', () => {
    const target = transcript();
    feed(target, [APPROVAL]);

    expect(target.pendingApprovalIds()).toEqual(['req-1']);
    target.resolveApproval('req-1', { source: 'expired', at: 5_000 });

    const approval = target.parts.find(
      (part): part is ExternalApprovalPart => part.type === 'external_approval'
    );
    expect(approval?.decisionSource).toBe('expired');
    expect(approval?.decision).toBeUndefined();
    expect(target.pendingApprovalIds()).toEqual([]);
  });

  it('merges sparse usage instead of letting a later report erase an earlier field', () => {
    const target = transcript();
    feed(target, [
      { type: 'usage', usage: { inputTokens: 100 } },
      { type: 'usage', usage: { outputTokens: 20 } },
    ]);

    expect(target.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
  });

  it('accumulates usage that arrives before completion', () => {
    const target = transcript();
    feed(target, [{ type: 'usage', usage: { inputTokens: 7 } }, { type: 'completed' }]);

    expect(target.usage).toEqual({ inputTokens: 7 });
    expect(target.turnPart.terminalReason).toBe('completed');
  });

  it('keeps the vendor error structured on the turn record', () => {
    const target = transcript();
    const [application] = feed(target, [
      {
        type: 'error',
        error: { code: 'adapter-stream', message: 'boom', vendorCode: 'E_BOOM', retryable: false },
      },
    ]);

    expect(application?.terminal).toBe('vendor-error');
    expect(target.turnPart.error).toMatchObject({ vendorCode: 'E_BOOM', retryable: false });
  });

  it('terminates on the event budget and keeps what it already had', () => {
    const target = transcript({ maxEvents: 2 });
    const applications = feed(target, [
      { type: 'text_delta', text: 'a' },
      { type: 'text_delta', text: 'b' },
      { type: 'text_delta', text: 'c' },
    ]);

    expect(applications.at(-1)?.terminal).toBe('limit-exceeded');
    expect(target.text).toBe('abc');
    expect(target.turnPart.status).toBe('terminal');
  });

  it('does not charge observational session state against the event budget', () => {
    const target = transcript({ maxEvents: 1 });
    const limits = {
      targetId: 'codex' as const,
      windows: [{ usedPercent: 10 }],
      observedAtMs: 2_000,
    };
    const applications = feed(target, [
      { type: 'text_delta', text: 'ok' },
      // Far more observational events than the budget — must not terminate.
      ...Array.from({ length: 20 }, () => ({
        type: 'thread_usage' as const,
        usage: { last: { inputTokens: 1 }, total: { inputTokens: 1 } },
      })),
      ...Array.from({ length: 20 }, () => ({
        type: 'account_limits' as const,
        limits,
      })),
      // The slash-command catalog is the same class of thing, and the widest of
      // the three: Cursor replays it into every turn and re-announces it live,
      // so a charged catalog would spend a turn's budget on a menu that is
      // never written down.
      ...Array.from({ length: 20 }, () => ({
        type: 'commands_available' as const,
        commands: [{ name: 'review', description: 'Read a diff' }],
      })),
      { type: 'completed' as const },
    ]);

    expect(applications.every((application) => application.terminal !== 'limit-exceeded')).toBe(
      true
    );
    expect(applications.at(-1)?.terminal).toBe('completed');
    expect(target.turnPart.status).toBe('terminal');
    expect(target.turnPart.eventCount).toBe(2);
    expect(target.terminated).toBe(true);
  });

  it('reports the reason it recorded when a terminal event also crosses the budget', () => {
    const target = transcript({ maxEvents: 1 });
    const applications = feed(target, [{ type: 'text_delta', text: 'a' }, { type: 'completed' }]);

    // The event was terminal in its own right; the budget does not get to
    // relabel a turn the transcript already recorded as completed.
    expect(applications.at(-1)?.terminal).toBe('completed');
    expect(target.turnPart.terminalReason).toBe('completed');
  });

  it('terminates on the byte budget', () => {
    const target = transcript({ maxBytes: 40 });
    const applications = feed(target, [
      { type: 'text_delta', text: 'x'.repeat(30) },
      { type: 'text_delta', text: 'y'.repeat(30) },
    ]);

    expect(applications.at(-1)?.terminal).toBe('limit-exceeded');
  });

  it('charges a steer against the byte budget and terminates once it crosses', () => {
    const target = transcript({ maxBytes: 40 });
    target.recordSteerAttempt({ clientMessageId: 'steer-1', text: 'x'.repeat(30) }, 2_000);
    const second = target.recordSteerAttempt(
      { clientMessageId: 'steer-2', text: 'y'.repeat(30) },
      2_001
    );

    expect(second.terminal).toBe('limit-exceeded');
    expect(target.turnPart.status).toBe('terminal');
    expect(target.turnPart.persistedBytes).toBe(60);
    // Both attempts are already durable — kept, exactly like the vendor event
    // that crosses the same line in `apply`.
    expect(target.parts.filter((part) => part.type === 'external_steer')).toHaveLength(2);
  });

  it('does not charge or terminate for a steer within budget', () => {
    const target = transcript({ maxBytes: 1_000 });
    const result = target.recordSteerAttempt({ clientMessageId: 'steer-1', text: 'hello' }, 2_000);

    expect(result.terminal).toBeUndefined();
    expect(target.turnPart.status).toBe('active');
    expect(target.turnPart.persistedBytes).toBe(5);
  });

  it('lets the first terminal writer win', () => {
    const target = transcript();
    target.finalize('cancelled-by-user', 3_000);
    target.finalize('completed', 4_000);

    expect(target.turnPart.terminalReason).toBe('cancelled-by-user');
    expect(target.turnPart.updatedAt).toBe(3_000);
  });

  /**
   * A user pressing Stop must never read "The agent stopped this turn."
   *
   * That is the mirror of the lie `interrupted` exists to prevent, and it is
   * reachable: the hub terminates on cancel, and the vendor's own
   * `cancelled` + `completed` pair arrives immediately afterwards as the
   * process winds down. First-terminal-writer-wins is what keeps the user's
   * own action as the recorded reason, so it is asserted rather than assumed.
   */
  it('keeps a hub cancel as the reason when the vendor then reports its own', () => {
    const target = transcript();
    target.finalize('cancelled-by-user', 3_000);
    feed(target, [{ type: 'cancelled' }, { type: 'completed' }]);

    expect(target.turnPart.terminalReason).toBe('cancelled-by-user');
  });

  it('records a vendor-initiated stop as interrupted, not as the user stopping', () => {
    const target = transcript();
    feed(target, [{ type: 'cancelled' }, { type: 'completed' }]);

    expect(target.turnPart.terminalReason).toBe('interrupted');
    expect(target.turnPart.status).toBe('terminal');
  });

  /**
   * A cancel is a controller-driven `finalize`, not a vendor `completed`
   * event through `apply` — the empty-block drop has to be inside `finalize`
   * itself, not something only the `completed`/`error` cases in `apply` do.
   */
  it('drops a trailing empty reasoning phase even when the controller finalizes directly', () => {
    const target = transcript();
    feed(target, [{ type: 'reasoning_started' }]);
    target.finalize('cancelled-by-user', 5_000);

    expect(target.parts.map((part) => part.type)).toEqual(['external_turn']);
  });

  /**
   * No vendor event describes a sentence stopping mid-thought, so the turn's
   * own terminal reason is the cheapest source that is still correct — and
   * the only one that covers all nine terminal reasons, not just the ones an
   * adapter happens to have a more specific signal for.
   */
  it('marks the trailing text as incomplete when the turn ends for any reason but completed', () => {
    const target = transcript();
    feed(target, [{ type: 'text_delta', text: 'partial' }]);
    target.finalize('runtime-disconnected', 5_000);

    expect(target.parts.at(-1)).toMatchObject({ type: 'text', text: 'partial', incomplete: true });
  });

  it('marks the trailing thinking part as incomplete the same way', () => {
    const target = transcript();
    feed(target, [{ type: 'reasoning_delta', text: 'weighing it' }]);
    target.finalize('sequence-gap', 5_000);

    expect(target.parts.at(-1)).toMatchObject({
      type: 'thinking',
      text: 'weighing it',
      incomplete: true,
    });
  });

  /**
   * The turn stopped inside the reasoning phase, not inside the paragraph
   * before it — the vendor finished that paragraph and moved on. Marking it
   * would tell the reader a completed sentence was cut off, and the phase
   * itself has no text to have been cut off, so nothing is marked at all.
   */
  it('marks nothing when the turn stopped inside a reasoning phase that produced no text', () => {
    const target = transcript();
    feed(target, [
      { type: 'text_delta', text: 'Here is the plan.' },
      { type: 'reasoning_started' },
    ]);
    target.finalize('cancelled-by-user', 5_000);

    expect(target.parts.map((part) => part.type)).toEqual(['external_turn', 'text']);
    expect(target.parts.at(-1)).not.toHaveProperty('incomplete');
  });

  /** The phase itself is what was cut short when it had already produced text. */
  it('marks the open reasoning phase when the turn stopped inside one that had text', () => {
    const target = transcript();
    feed(target, [
      { type: 'text_delta', text: 'Here is the plan.' },
      { type: 'reasoning_started' },
      { type: 'reasoning_delta', text: 'weighing' },
    ]);
    target.finalize('cancelled-by-user', 5_000);

    expect(target.parts.at(-1)).toMatchObject({ type: 'thinking', incomplete: true });
    expect(target.parts.at(-2)).not.toHaveProperty('incomplete');
  });

  /**
   * The phase the vendor closed is history: the turn was not inside it when it
   * stopped, so the trailing prose is what got cut short.
   */
  it('marks the trailing prose when the reasoning phase had already closed', () => {
    const target = transcript();
    feed(target, [
      { type: 'reasoning_started' },
      { type: 'reasoning_ended' },
      { type: 'text_delta', text: 'partial' },
    ]);
    target.finalize('cancelled-by-user', 5_000);

    expect(target.parts.at(-1)).toMatchObject({ type: 'text', text: 'partial', incomplete: true });
  });

  it('marks nothing when the turn completed normally', () => {
    const target = transcript();
    feed(target, [{ type: 'text_delta', text: 'done' }, { type: 'completed' }]);

    expect(target.parts.at(-1)).not.toHaveProperty('incomplete');
  });

  it('does not mark a part that is not trailing', () => {
    const target = transcript();
    feed(target, [
      { type: 'text_delta', text: 'before' },
      {
        type: 'activity_started',
        callId: 'call-1',
        activity: { name: 'shell', kind: 'command', title: 'ls' },
      },
    ]);
    target.finalize('cancelled-by-user', 5_000);

    const text = target.parts.find((part) => part.type === 'text');
    expect(text).not.toHaveProperty('incomplete');
  });

  /**
   * The ordering commit 4 and this one depend on: a cancelled turn can end
   * with an empty thinking part trailing. Dropping it has to run first, so
   * the mark lands on whatever is trailing *after* that — never on the empty
   * block this same call is about to delete.
   */
  it('drops an empty trailing reasoning phase before marking anything incomplete', () => {
    const target = transcript();
    feed(target, [{ type: 'reasoning_started' }]);
    target.finalize('cancelled-by-user', 5_000);

    expect(target.parts.map((part) => part.type)).toEqual(['external_turn']);
    expect(target.parts.some((part) => 'incomplete' in part)).toBe(false);
  });

  it("never persists the vendor's own session handle", () => {
    const target = transcript();
    feed(target, [{ type: 'session_started', sessionId: 'vendor-secret', resumed: true }]);

    expect(JSON.stringify(target.parts)).not.toContain('vendor-secret');
  });
});
