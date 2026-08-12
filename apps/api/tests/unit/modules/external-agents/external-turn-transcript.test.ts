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

  it('does not charge observational account/thread usage against the event budget', () => {
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

  it("never persists the vendor's own session handle", () => {
    const target = transcript();
    feed(target, [{ type: 'session_started', sessionId: 'vendor-secret', resumed: true }]);

    expect(JSON.stringify(target.parts)).not.toContain('vendor-secret');
  });
});
