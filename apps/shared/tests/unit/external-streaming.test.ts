import { describe, expect, it } from 'bun:test';
import Value from 'typebox/value';

import type { ExternalAgentEvent } from '../../src/external-agents';
import {
  externalAgentEventToStreamChunk,
  externalSessionStartedChunk,
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
  // Appended rather than placed in union order: the option-set case below
  // indexes into this array. One vendor sends help text with each name and the
  // other sends names alone, so both halves are represented.
  {
    type: 'commands_available',
    commands: [{ name: 'review', description: 'Read a diff' }, { name: 'compact' }],
  },
];

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
    const chunk = externalAgentEventToStreamChunk(EVERY_EVENT[6] as ExternalAgentEvent);
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
