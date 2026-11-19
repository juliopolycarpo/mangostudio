import { describe, expect, it } from 'bun:test';

import Value from 'typebox/value';

import { EXTERNAL_TURN_TERMINAL_REASONS, type ExternalAgentEvent } from '../../src/external-agents';
import {
  externalAgentEventToStreamChunk,
  externalSessionStartedChunk,
  externalSteerChunk,
  externalTurnCompletedChunk,
  externalTurnWaitingChunk,
  StreamChunkSchema,
} from '../../src/streaming';

/**
 * One of every neutral event, so a new member added to the contract without a
 * corresponding chunk fails here rather than being silently dropped on the wire.
 */
const EVERY_EVENT: readonly ExternalAgentEvent[] = [
  { type: 'session_started', sessionId: 'thread_1', resumed: false },
  { type: 'text_delta', text: 'hello' },
  { type: 'reasoning_delta', text: 'considering' },
  {
    type: 'activity_started',
    callId: 'call_1',
    activity: { name: 'shell', kind: 'command', title: 'ls -la', detail: 'in /tmp' },
  },
  { type: 'activity_updated', callId: 'call_1', update: { detail: 'still running' } },
  { type: 'activity_completed', callId: 'call_1', result: { status: 'completed' } },
  {
    type: 'approval_requested',
    request: {
      requestId: 'req_1',
      kind: 'command',
      title: 'Run `rm -rf build`',
      options: [
        { id: 'approve', rawLabel: 'Approve for this session', isDestructive: false },
        { id: 'deny', rawLabel: 'Deny', isDestructive: true },
      ],
      expiresAtMs: 1_700_000_000_000,
    },
  },
  {
    type: 'approval_resolved',
    requestId: 'req_1',
    decision: { optionId: 'approve', source: 'user' },
  },
  { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } },
  { type: 'completed' },
  { type: 'notice', severity: 'warning', title: 'Rate limit close', description: 'Resets soon.' },
  { type: 'error', error: { code: 'vendor_failed', message: 'boom' } },
  // One vendor sends help text with each name and the other sends names alone,
  // so both halves are represented.
  {
    type: 'commands_available',
    commands: [{ name: 'review', description: 'Read a diff' }, { name: 'compact' }],
  },
];

/** Picks a fixture by its `type`, so reordering `EVERY_EVENT` cannot retarget a test. */
function eventOfType<T extends ExternalAgentEvent['type']>(
  type: T
): Extract<ExternalAgentEvent, { type: T }> {
  const matches = EVERY_EVENT.filter(
    (event): event is Extract<ExternalAgentEvent, { type: T }> => event.type === type
  );
  if (matches.length !== 1) {
    throw new Error(
      `(EVERY_EVENT): expected exactly one '${type}' fixture | received: ${matches.length}`
    );
  }
  return matches[0] as Extract<ExternalAgentEvent, { type: T }>;
}

describe('external stream chunks', () => {
  it('maps every neutral event to a valid chunk, or to nothing on purpose', () => {
    const unmapped: string[] = [];
    for (const event of EVERY_EVENT) {
      const chunk = externalAgentEventToStreamChunk(event);
      if (chunk === null) {
        unmapped.push(event.type);
        continue;
      }
      expect(Value.Check(StreamChunkSchema, chunk)).toBe(true);
      expect(chunk.type.startsWith('external_')).toBe(true);
    }
    // `session_started` is re-announced with the hub's own id; `completed` is the
    // turn's ordinary `done`. Anything else here is an event nobody renders.
    expect(unmapped.sort()).toEqual(['completed', 'session_started']);
  });

  it('projects a notice with its severity and words, and never as text', () => {
    const chunk = externalAgentEventToStreamChunk({
      type: 'notice',
      severity: 'error',
      title: 'Retrying',
    });
    expect(chunk).toEqual({
      type: 'external_notice',
      severity: 'error',
      title: 'Retrying',
      done: false,
    });
    expect(Value.Check(StreamChunkSchema, chunk)).toBe(true);
  });

  it('never puts the vendor session handle on the wire', () => {
    expect(
      externalAgentEventToStreamChunk({
        type: 'session_started',
        sessionId: 'vendor-secret',
        resumed: true,
      })
    ).toBeNull();

    const chunk = externalSessionStartedChunk({
      sessionId: 'hub-minted',
      targetId: 'codex',
      resumed: true,
      fallbackReason: 'thread expired',
    });
    expect(Value.Check(StreamChunkSchema, chunk)).toBe(true);
    expect(JSON.stringify(chunk)).not.toContain('vendor-secret');
  });

  it('omits an absent fallback reason rather than sending an empty one', () => {
    const chunk = externalSessionStartedChunk({
      sessionId: 'hub-minted',
      targetId: 'codex',
      resumed: false,
    });
    expect(chunk).not.toHaveProperty('fallbackReason');
  });

  it('preserves the vendor option set exactly, in the vendor order', () => {
    const chunk = externalAgentEventToStreamChunk(eventOfType('approval_requested'));
    expect(chunk).toMatchObject({
      type: 'external_approval_request',
      options: [
        { id: 'approve', rawLabel: 'Approve for this session', isDestructive: false },
        { id: 'deny', rawLabel: 'Deny', isDestructive: true },
      ],
    });
  });

  it('marks a failed activity as an error from the status alone', () => {
    expect(
      externalAgentEventToStreamChunk({
        type: 'activity_completed',
        callId: 'call_1',
        result: { status: 'failed', detail: 'exit 1' },
      })
    ).toEqual({
      type: 'external_activity_completed',
      callId: 'call_1',
      status: 'failed',
      detail: 'exit 1',
      isError: true,
      done: false,
    });

    expect(
      externalAgentEventToStreamChunk({
        type: 'activity_completed',
        callId: 'call_1',
        result: { status: 'cancelled' },
      })
    ).not.toHaveProperty('isError');
  });
});

describe('externalTurnCompletedChunk', () => {
  // The constant is derived from the schema union, so a reason added there is
  // covered here without touching this file.
  it.each([...EXTERNAL_TURN_TERMINAL_REASONS])(
    'projects the %s reason onto a valid, non-final chunk',
    (reason) => {
      const chunk = externalTurnCompletedChunk(reason);

      expect(chunk).toEqual({ type: 'external_turn_completed', reason, done: false });
      expect(
        Value.Check(StreamChunkSchema, chunk),
        `(external_turn_completed): expected '${reason}' chunk to satisfy StreamChunkSchema`
      ).toBe(true);
    }
  );
});

describe('externalTurnWaitingChunk', () => {
  it.each(['runtime-unreachable', 'runtime-busy'] as const)(
    'projects the %s cause onto a valid, non-final chunk',
    (cause) => {
      const chunk = externalTurnWaitingChunk(cause);

      expect(chunk).toEqual({ type: 'external_turn_waiting', cause, done: false });
      expect(
        Value.Check(StreamChunkSchema, chunk),
        `(external_turn_waiting): expected '${cause}' chunk to satisfy StreamChunkSchema`
      ).toBe(true);
    }
  );

  it('ends the wait with a chunk that carries no cause', () => {
    const chunk = externalTurnWaitingChunk(undefined);

    expect(chunk).toEqual({ type: 'external_turn_waiting', done: false });
    expect(Value.Check(StreamChunkSchema, chunk)).toBe(true);
  });

  it('rejects a cause the contract does not name', () => {
    expect(
      Value.Check(StreamChunkSchema, {
        type: 'external_turn_waiting',
        cause: 'stuck',
        done: false,
      }),
      `(external_turn_waiting): expected 'stuck' cause to violate StreamChunkSchema`
    ).toBe(false);
  });
});

describe('externalSteerChunk', () => {
  it('projects an unknown delivery onto a valid, non-final chunk with no reason code', () => {
    const chunk = externalSteerChunk({
      clientMessageId: 'steer-1',
      text: 'use the helper',
      status: 'delivery-unknown',
    });

    expect(chunk).toEqual({
      type: 'external_steer',
      clientMessageId: 'steer-1',
      text: 'use the helper',
      status: 'delivery-unknown',
      done: false,
    });
    expect(
      Value.Check(StreamChunkSchema, chunk),
      `(external_steer): expected a 'delivery-unknown' chunk to satisfy StreamChunkSchema | received: ${JSON.stringify(chunk)}`
    ).toBe(true);
  });

  it('still projects accepted and rejected steers', () => {
    const accepted = externalSteerChunk({ clientMessageId: 'a', text: 't', status: 'accepted' });
    const rejected = externalSteerChunk({
      clientMessageId: 'r',
      text: 't',
      status: 'rejected',
      reasonCode: 'turn-not-steerable',
    });

    expect(accepted).toMatchObject({ status: 'accepted' });
    expect(rejected).toMatchObject({ status: 'rejected', reasonCode: 'turn-not-steerable' });
    expect(Value.Check(StreamChunkSchema, accepted)).toBe(true);
    expect(Value.Check(StreamChunkSchema, rejected)).toBe(true);
  });

  it('refuses an unknown-delivery chunk that also claims a reason code', () => {
    const chunk = {
      type: 'external_steer',
      clientMessageId: 'steer-1',
      text: 't',
      status: 'delivery-unknown',
      reasonCode: 'turn-not-steerable',
      done: false,
    };

    expect(Value.Check(StreamChunkSchema, chunk)).toBe(false);
  });
});

describe('an external error chunk with a remedy', () => {
  const error = { code: 'acp-auth-required', message: 'authentication required' };
  const remedy = { kind: 'sign-in', command: 'cursor-agent login' } as const;

  it('carries the remedy beside the vendor error, which stays untouched', () => {
    const chunk = externalAgentEventToStreamChunk({ type: 'error', error }, undefined, remedy);

    expect(chunk).toEqual({ type: 'external_error', error, remedy, done: false });
    expect(Value.Check(StreamChunkSchema, chunk), 'the chunk validates').toBe(true);
  });

  it('has no remedy key when none is offered, as a hub without the feature sends it', () => {
    const chunk = externalAgentEventToStreamChunk({ type: 'error', error });

    expect(chunk).toEqual({ type: 'external_error', error, done: false });
  });

  it('carries the reason and build the hub recorded beside a refused start, and validates', () => {
    const chunk = externalAgentEventToStreamChunk(
      { type: 'error', error },
      undefined,
      { kind: 'update' },
      { unavailableReason: 'version-unsupported', requiredVersion: '0.153.4' }
    );

    expect(chunk).toEqual({
      type: 'external_error',
      error,
      remedy: { kind: 'update' },
      unavailableReason: 'version-unsupported',
      requiredVersion: '0.153.4',
      done: false,
    });
    expect(Value.Check(StreamChunkSchema, chunk), 'the chunk validates').toBe(true);
  });

  it('refuses a reason that is not one of the closed set', () => {
    const chunk = { type: 'external_error', error, unavailableReason: 'on-fire', done: false };

    expect(Value.Check(StreamChunkSchema, chunk)).toBe(false);
  });

  it('refuses a remedy that is not one of the closed kinds', () => {
    const chunk = { type: 'external_error', error, remedy: { kind: 'run-it-for-me' }, done: false };

    expect(Value.Check(StreamChunkSchema, chunk)).toBe(false);
  });
});

describe('an SSE error chunk that says why an agent could not start', () => {
  const base = {
    type: 'error',
    error: 'The external agent turn could not be started.',
    done: true,
  };

  it('validates with the reason and remedy, and without them as an older hub sends it', () => {
    const withReason = {
      ...base,
      unavailableReason: 'signed-out',
      remedy: { kind: 'sign-in', command: 'cursor-agent login' },
    };

    expect([
      Value.Check(StreamChunkSchema, withReason),
      Value.Check(StreamChunkSchema, base),
    ]).toEqual([true, true]);
  });

  it('refuses a reason or a remedy kind outside the closed sets', () => {
    expect([
      Value.Check(StreamChunkSchema, { ...base, unavailableReason: 'on-fire' }),
      Value.Check(StreamChunkSchema, { ...base, remedy: { kind: 'run-it-for-me' } }),
    ]).toEqual([false, false]);
  });
});

describe('an SSE error chunk that names the build an outdated agent needs', () => {
  const base = {
    type: 'error',
    error: 'The external agent turn could not be started.',
    unavailableReason: 'version-unsupported',
    remedy: { kind: 'update' },
    done: true,
  };

  it('validates with the required version, and without it as an older hub sends it', () => {
    expect([
      Value.Check(StreamChunkSchema, { ...base, requiredVersion: '0.153.4' }),
      Value.Check(StreamChunkSchema, base),
    ]).toEqual([true, true]);
  });

  it('refuses an empty or oversized required version', () => {
    expect([
      Value.Check(StreamChunkSchema, { ...base, requiredVersion: '' }),
      Value.Check(StreamChunkSchema, { ...base, requiredVersion: '9'.repeat(65) }),
    ]).toEqual([false, false]);
  });
});
