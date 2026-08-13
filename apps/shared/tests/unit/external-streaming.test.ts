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
  { type: 'error', error: { code: 'vendor_failed', message: 'boom' } },
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
