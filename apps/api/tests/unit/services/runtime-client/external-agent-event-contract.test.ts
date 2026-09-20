import { describe, expect, it } from 'bun:test';
import { RUNTIME_EXTERNAL_AGENT_TOPIC } from '@mangostudio/shared/runtime-contract';
import { openHubSession } from '../../../../src/services/runtime-client/hub-session';
import { RuntimeClient } from '../../../../src/services/runtime-client/runtime-client';
import { FakeHostileRuntimePeer } from '../../../support/mocks/fake-hostile-runtime-peer';

/**
 * A well-addressed envelope around whatever `event` the test wants to send.
 * `streamId` mirrors `sessionId`, exactly as the real runtime sets it
 * (`supervisor.ts`'s `#emitEvent`) — the hub's session boundary now requires
 * one on every streamed topic.
 */
function envelope(event: unknown) {
  return {
    topic: RUNTIME_EXTERNAL_AGENT_TOPIC,
    streamId: 'session-1',
    payload: { sessionId: 'session-1', sequence: 1, emittedAtMs: 0, event },
  };
}

describe('RuntimeClient.externalAgents.onEvent — known-event contract validation', () => {
  it('delivers a well-formed known event unchanged', async () => {
    const peer = new FakeHostileRuntimePeer();
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });
    const client = new RuntimeClient(hub);
    const received: unknown[] = [];
    client.externalAgents.onEvent('session-1', (frame) => received.push(frame.event));

    peer.emit(envelope({ type: 'completed' }));
    await Promise.resolve();

    expect(received).toEqual([{ type: 'completed' }]);
    hub.close();
  });

  it('passes an unrecognized event type through unchanged, for forward compatibility', async () => {
    const peer = new FakeHostileRuntimePeer();
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });
    const client = new RuntimeClient(hub);
    const received: unknown[] = [];
    client.externalAgents.onEvent('session-1', (frame) => received.push(frame.event));

    peer.emit(envelope({ type: 'future_event_kind', anything: 'goes' }));
    await Promise.resolve();

    expect(received).toEqual([{ type: 'future_event_kind', anything: 'goes' }]);
    hub.close();
  });

  it('substitutes a terminal error event for a malformed `error` event', async () => {
    const peer = new FakeHostileRuntimePeer();
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });
    const client = new RuntimeClient(hub);
    const received: unknown[] = [];
    client.externalAgents.onEvent('session-1', (frame) => received.push(frame.event));

    // `error` is a known, settling type; its own `error` field must be an
    // object with `code`/`message`, not a string.
    peer.emit(envelope({ type: 'error', error: 'SECRET-error-99' }));
    await Promise.resolve();

    expect(received).toHaveLength(1);
    const event = received[0] as { type: string; error?: { code: string; message: string } };
    expect(event.type).toBe('error');
    expect(event.error?.code).toBe('contract_violation');
    expect(event.error?.message).toContain('error');
    // Redaction: the malformed value itself must never reach a consumer.
    expect(event.error?.message).not.toContain('SECRET-error-99');
    hub.close();
  });

  it('substitutes a terminal error event for an `error` event with an additive field', async () => {
    // `error`'s branch of `ExternalAgentEventSchema` is closed, as the whole
    // `external-agent.*` family deliberately is (`contract.ts`): an
    // additively-extended `error` event must be treated as malformed here,
    // not passed through. Passing it through would reach
    // `external-turn-controller.ts`'s own strict `Value.Check`, which logs
    // `unrecognized_event_type` and returns without finalizing — the turn
    // hangs, the exact #988 shape, reached through this substitution path.
    const peer = new FakeHostileRuntimePeer();
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });
    const client = new RuntimeClient(hub);
    const received: unknown[] = [];
    client.externalAgents.onEvent('session-1', (frame) => received.push(frame.event));

    peer.emit(envelope({ type: 'error', error: { code: 'x', message: 'y' }, extra: 1 }));
    await Promise.resolve();

    expect(received).toHaveLength(1);
    const event = received[0] as { type: string; error?: { code: string } };
    expect(event.type).toBe('error');
    expect(event.error?.code).toBe('contract_violation');
    hub.close();
  });

  it('leaves a malformed non-settling known type untouched, for the controller’s own inert drop', async () => {
    // `usage` is progress, not a turn terminal: `external-turn-controller.ts`
    // already treats any event that fails `Value.Check(ExternalAgentEventSchema,
    // …)` as inert and moves on. Substituting `error` here would end the turn
    // over one broken progress update instead of costing it one log line.
    const peer = new FakeHostileRuntimePeer();
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });
    const client = new RuntimeClient(hub);
    const received: unknown[] = [];
    client.externalAgents.onEvent('session-1', (frame) => received.push(frame.event));

    peer.emit(envelope({ type: 'usage', usage: 'not-an-object' }));
    await Promise.resolve();

    expect(received).toEqual([{ type: 'usage', usage: 'not-an-object' }]);
    hub.close();
  });

  it('still admits the sequence number of a malformed-but-well-addressed event', async () => {
    // The envelope itself is sound — only `event`'s shape is wrong — so the
    // hub's session boundary delivers it rather than closing the connection;
    // dropping it here would strand this sequence number and turn the next,
    // perfectly ordinary event into a gap (#964).
    const peer = new FakeHostileRuntimePeer();
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });
    const client = new RuntimeClient(hub);
    const received: unknown[] = [];
    client.externalAgents.onEvent('session-1', (frame) => received.push(frame));

    peer.emit(envelope({ type: 'usage', usage: 'not-an-object' }));
    await Promise.resolve();

    expect(received).toHaveLength(1);
    hub.close();
  });
});
