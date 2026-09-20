import { describe, expect, it } from 'bun:test';
import { CLOSE_CODES } from '@mangostudio/protocol';
import {
  RUNTIME_EXTERNAL_AGENT_TOPIC,
  RUNTIME_HEARTBEAT_TOPIC,
  RUNTIME_TERMINAL_OUTPUT_TOPIC,
} from '@mangostudio/shared/runtime-contract';
import { openHubSession } from '../../../../src/services/runtime-client/hub-session';
import { FakeHostileRuntimePeer } from '../../../support/mocks/fake-hostile-runtime-peer';

describe('openHubSession — result validation', () => {
  it('rejects a method result that does not match the contract', async () => {
    const peer = new FakeHostileRuntimePeer();
    peer.answer('runtime.health', { unexpectedShape: 'SENTINEL-7f3a' });
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });

    let error: unknown;
    try {
      await hub.request('runtime.health', {});
      throw new Error('expected hub.request to reject; the malformed result resolved instead');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('runtime.health');
    // Redaction is the acceptance criterion: the rejected payload's own values
    // must never reach the diagnostic.
    expect(message).not.toContain('SENTINEL-7f3a');
    hub.close();
  });

  it('resolves a method result that matches the contract', async () => {
    const peer = new FakeHostileRuntimePeer();
    peer.answer('install.cancel', { ok: true });
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });
    const ack = await hub.request('install.cancel', { runId: 'run-1' });
    expect(ack).toEqual({ ok: true });
    hub.close();
  });

  it('tolerates an additive field from a newer runtime instead of rejecting the whole result', async () => {
    // Every remote transport sets `requireMatchingRelease: false` — a hub and
    // a runtime are allowed to run different releases, and an extra field is
    // exactly the shape that drift takes. Rejecting it here would turn a
    // supported deployment into an outage on the runtime's next release.
    const peer = new FakeHostileRuntimePeer();
    peer.answer('install.cancel', { ok: true, futureField: 'from-a-newer-runtime' });
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });
    const ack = await hub.request('install.cancel', { runId: 'run-1' });
    expect(ack).toMatchObject({ ok: true });
    hub.close();
  });

  it('tolerates an additive field inside a discriminated-union result', async () => {
    // `workspace.validate`'s result is `Type.Union([{ok:true,...}, {ok:false,...}])`
    // — the one result schema in the catalog with a top-level union. A naive
    // "filter Value.Errors by keyword" fix would see the *other* branch's
    // unrelated `const` mismatch and reject this even though the matching
    // branch is otherwise fine.
    const peer = new FakeHostileRuntimePeer();
    peer.answer('workspace.validate', {
      ok: true,
      resolvedPath: '/workspace',
      futureField: 'from-a-newer-runtime',
    });
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });
    const result = await hub.request('workspace.validate', { path: '/workspace' });
    expect(result).toMatchObject({ ok: true, resolvedPath: '/workspace' });
    hub.close();
  });
});

describe('openHubSession — event validation', () => {
  it('forwards an unknown topic unchanged, for forward compatibility', async () => {
    const peer = new FakeHostileRuntimePeer();
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });
    const received: unknown[] = [];
    hub.onEvent((frame) => received.push(frame));

    peer.emit({ topic: 'x-vendor.future-topic', payload: { anything: 'goes' } });
    await Promise.resolve();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      topic: 'x-vendor.future-topic',
      payload: { anything: 'goes' },
    });
    hub.close();
  });

  it('drops a malformed known, non-critical topic without closing the session', async () => {
    const peer = new FakeHostileRuntimePeer();
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });
    const received: unknown[] = [];
    let closed = false;
    hub.onEvent((frame) => received.push(frame));
    hub.onClose(() => {
      closed = true;
    });

    peer.emit({ topic: RUNTIME_HEARTBEAT_TOPIC, payload: { at: 'not-a-number' } });
    await Promise.resolve();

    expect(received).toEqual([]);
    expect(closed).toBe(false);
    hub.close();
  });

  it('closes the session on a terminal.output frame with a recognized kind and a broken field', async () => {
    const peer = new FakeHostileRuntimePeer();
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });
    const received: unknown[] = [];
    const closure = Promise.withResolvers<{ code: number }>();
    hub.onEvent((frame) => received.push(frame));
    hub.onClose((c) => closure.resolve(c));

    // `kind: 'data'` is recognized; `data` must be a string, not a number.
    peer.emit({
      topic: RUNTIME_TERMINAL_OUTPUT_TOPIC,
      streamId: 'terminal-1',
      payload: { kind: 'data', data: 123 },
    });

    const closed = await closure.promise;
    expect(closed.code).toBe(CLOSE_CODES.PROTOCOL_ERROR);
    expect(received).toEqual([]);
  });

  it('delivers a terminal.output frame with an unrecognized kind, for forward compatibility', async () => {
    const peer = new FakeHostileRuntimePeer();
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });
    const received: unknown[] = [];
    hub.onEvent((frame) => received.push(frame));

    peer.emit({
      topic: RUNTIME_TERMINAL_OUTPUT_TOPIC,
      streamId: 'terminal-1',
      payload: { kind: 'title', text: 'a kind this build has never heard of' },
    });
    await Promise.resolve();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ payload: { kind: 'title' } });
    hub.close();
  });

  it('closes the session on a malformed external-agent.event envelope', async () => {
    const peer = new FakeHostileRuntimePeer();
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });
    const received: unknown[] = [];
    const closure = Promise.withResolvers<{ code: number }>();
    hub.onEvent((frame) => received.push(frame));
    hub.onClose((c) => closure.resolve(c));

    // No `sequence`: the envelope itself is unaddressable, not just an event
    // type this build has never heard of.
    peer.emit({
      topic: RUNTIME_EXTERNAL_AGENT_TOPIC,
      payload: { sessionId: 'session-1', event: { type: 'completed' } },
    });

    const closed = await closure.promise;
    expect(closed.code).toBe(CLOSE_CODES.PROTOCOL_ERROR);
    expect(received).toEqual([]);
  });

  it('delivers an external-agent.event envelope with an additive field, for forward compatibility', async () => {
    const peer = new FakeHostileRuntimePeer();
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });
    const received: unknown[] = [];
    hub.onEvent((frame) => received.push(frame));

    peer.emit({
      topic: RUNTIME_EXTERNAL_AGENT_TOPIC,
      payload: {
        sessionId: 'session-1',
        sequence: 1,
        emittedAtMs: 0,
        traceId: 'from-a-newer-runtime',
        event: { type: 'completed' },
      },
    });
    await Promise.resolve();

    expect(received).toHaveLength(1);
    hub.close();
  });

  it('does not let one throwing listener stop another from seeing the frame', async () => {
    const peer = new FakeHostileRuntimePeer();
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });
    const received: unknown[] = [];
    hub.onEvent(() => {
      throw new Error('a broken consumer');
    });
    hub.onEvent((frame) => received.push(frame));

    peer.emit({ topic: RUNTIME_HEARTBEAT_TOPIC, payload: { at: 1 } });
    await Promise.resolve();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ topic: RUNTIME_HEARTBEAT_TOPIC, payload: { at: 1 } });
    hub.close();
  });
});
