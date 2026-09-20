import { describe, expect, it } from 'bun:test';
import { CLOSE_CODES } from '@mangostudio/protocol';
import {
  RUNTIME_EXTERNAL_AGENT_TOPIC,
  RUNTIME_HEARTBEAT_TOPIC,
  RUNTIME_INSTALL_OUTPUT_TOPIC,
  RUNTIME_TERMINAL_OUTPUT_TOPIC,
} from '@mangostudio/shared/runtime-contract';
import { openHubSession } from '../../../../src/services/runtime-client/hub-session';
import { FakeHostileRuntimePeer } from '../../../support/mocks/fake-hostile-runtime-peer';

describe('openHubSession — result validation', () => {
  it('rejects a method result that does not match the contract', async () => {
    const peer = new FakeHostileRuntimePeer();
    peer.answer('runtime.health', { unexpectedShape: 'SENTINEL-7f3a' });
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });

    // A rejected promise, not a resolved one carrying the bad value: an
    // `expect(...).toEqual` on a value that never arrived would pass for the
    // wrong reason, so this asserts the rejection itself.
    await expect(hub.request('runtime.health', {})).rejects.toThrow(/runtime\.health/);

    const error = await hub.request('runtime.health', {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    // Redaction is the acceptance criterion: the rejected payload's own values
    // must never reach the diagnostic.
    expect((error as Error).message).not.toContain('SENTINEL-7f3a');
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

  it('accepts an additive field on an open result, exactly as the contract itself allows', async () => {
    // `RUNTIME_CONTRACT`'s schemas are written open by default (`contract.ts`'s
    // own docblock); `install.cancel`'s result is one of them, so a plain
    // `Value.Check` already tolerates a field this build has never named — no
    // leniency of this boundary's own is involved.
    const peer = new FakeHostileRuntimePeer();
    peer.answer('install.cancel', { ok: true, futureField: 'from-a-newer-runtime' });
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });
    const ack = await hub.request('install.cancel', { runId: 'run-1' });
    expect(ack).toMatchObject({ ok: true });
    hub.close();
  });

  it('accepts an additive field inside an open discriminated-union result', async () => {
    // `workspace.validate`'s result is `Type.Union([{ok:true,...}, {ok:false,...}])`
    // with neither branch closed, so `Value.Check`'s own union semantics —
    // "matches if any branch matches" — already accept the additive field on
    // the matching branch.
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

  it('drops a streamed, non-critical topic frame missing its streamId, without closing', async () => {
    // `install.output` is a stream (one `streamId` per install run) but not a
    // fatal topic: `install-runner.ts` settles on `install.run`'s own RPC
    // result, not this stream. A schema-valid payload with no `streamId`
    // would otherwise pass this boundary and then be silently discarded by
    // whichever run it can't be matched to.
    const peer = new FakeHostileRuntimePeer();
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });
    const received: unknown[] = [];
    let closed = false;
    hub.onEvent((frame) => received.push(frame));
    hub.onClose(() => {
      closed = true;
    });

    peer.emit({ topic: RUNTIME_INSTALL_OUTPUT_TOPIC, payload: { stream: 'stdout', line: 'hi' } });
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

  it('closes the session on a terminal.output frame whose payload is not an object', async () => {
    // The peer's own frame must never decide whether it gets checked: `null`
    // is not a newer runtime's forward-compatible extension, it is malformed.
    const peer = new FakeHostileRuntimePeer();
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });
    const received: unknown[] = [];
    const closure = Promise.withResolvers<{ code: number }>();
    hub.onEvent((frame) => received.push(frame));
    hub.onClose((c) => closure.resolve(c));

    peer.emit({ topic: RUNTIME_TERMINAL_OUTPUT_TOPIC, streamId: 'terminal-1', payload: null });

    const closed = await closure.promise;
    expect(closed.code).toBe(CLOSE_CODES.PROTOCOL_ERROR);
    expect(received).toEqual([]);
  });

  it('closes the session on a terminal.output frame whose kind is not a string', async () => {
    const peer = new FakeHostileRuntimePeer();
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });
    const received: unknown[] = [];
    const closure = Promise.withResolvers<{ code: number }>();
    hub.onEvent((frame) => received.push(frame));
    hub.onClose((c) => closure.resolve(c));

    peer.emit({
      topic: RUNTIME_TERMINAL_OUTPUT_TOPIC,
      streamId: 'terminal-1',
      payload: { kind: 123, data: {} },
    });

    const closed = await closure.promise;
    expect(closed.code).toBe(CLOSE_CODES.PROTOCOL_ERROR);
    expect(received).toEqual([]);
  });

  it('delivers a terminal.output frame with an unrecognized *string* kind, for forward compatibility', async () => {
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
    // type this build has never heard of. `streamId` is present and correct
    // so this genuinely exercises the envelope check, not the frame guard.
    peer.emit({
      topic: RUNTIME_EXTERNAL_AGENT_TOPIC,
      streamId: 'session-1',
      payload: { sessionId: 'session-1', event: { type: 'completed' } },
    });

    const closed = await closure.promise;
    expect(closed.code).toBe(CLOSE_CODES.PROTOCOL_ERROR);
    expect(received).toEqual([]);
  });

  it('closes the session on an external-agent.event envelope with an additive field', async () => {
    // Unlike the rest of the catalog, the `external-agent.*` family — the
    // envelope included — is closed on purpose, as a review boundary: "a
    // member nobody declared is a vendor surface nobody reviewed"
    // (`contract.ts`). An additive envelope field is not tolerated here.
    const peer = new FakeHostileRuntimePeer();
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });
    const received: unknown[] = [];
    const closure = Promise.withResolvers<{ code: number }>();
    hub.onEvent((frame) => received.push(frame));
    hub.onClose((c) => closure.resolve(c));

    peer.emit({
      topic: RUNTIME_EXTERNAL_AGENT_TOPIC,
      streamId: 'session-1',
      payload: {
        sessionId: 'session-1',
        sequence: 1,
        emittedAtMs: 0,
        injectedMember: 'unreviewed',
        event: { type: 'completed' },
      },
    });

    const closed = await closure.promise;
    expect(closed.code).toBe(CLOSE_CODES.PROTOCOL_ERROR);
    expect(received).toEqual([]);
  });

  it('delivers an external-agent.event frame with no streamId, since no consumer depends on it', async () => {
    // Unlike `terminal.output`/`install.output`, `RuntimeClient.externalAgents
    // .onEvent` addresses by `payload.sessionId`, never `frame.streamId` — so
    // a missing one here causes no downstream harm and is not fatal.
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
        event: { type: 'completed' },
      },
    });
    await Promise.resolve();

    expect(received).toHaveLength(1);
    hub.close();
  });

  it('closes the session on a terminal.output frame missing its streamId, and names the frame not the payload', async () => {
    const peer = new FakeHostileRuntimePeer();
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });
    const received: unknown[] = [];
    const closure = Promise.withResolvers<{ code: number; reason?: string }>();
    hub.onEvent((frame) => received.push(frame));
    hub.onClose((c) => closure.resolve(c));

    // A well-formed `data` payload — the only thing wrong is the missing
    // frame-level `streamId`, and the close reason must say so rather than
    // naming a payload violation that does not exist.
    peer.emit({ topic: RUNTIME_TERMINAL_OUTPUT_TOPIC, payload: { kind: 'data', data: 'hi' } });

    const closed = await closure.promise;
    expect(closed.code).toBe(CLOSE_CODES.PROTOCOL_ERROR);
    expect(closed.reason).toContain('streamId');
    expect(received).toEqual([]);
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

  it('does not let one throwing onClose listener stop another from settling', async () => {
    const peer = new FakeHostileRuntimePeer();
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });
    let settled = false;
    hub.onClose(() => {
      throw new Error('a broken teardown listener');
    });
    hub.onClose(() => {
      settled = true;
    });

    hub.close();
    await Promise.resolve();

    expect(settled).toBe(true);
  });

  it('replays the close to a listener that subscribes after the session already closed', async () => {
    // `Session.onClose` replays the closure on a microtask to a late
    // subscriber — every real teardown consumer (`external-session-manager.ts`,
    // `terminal-session-service.ts`, `mcp/runtime-session.ts`,
    // `spawn-runtime-child.ts`'s connection eviction) registers after an
    // awaited round trip, squarely inside that window. `onClose` must not
    // fan out through a subscription taken once at `openHubSession` time,
    // or exactly this replay is lost.
    const peer = new FakeHostileRuntimePeer();
    const hub = await openHubSession(peer.hubPort, { hubVersion: 'hub-test' });

    hub.close();
    await Promise.resolve();
    await Promise.resolve();

    let fired = false;
    hub.onClose(() => {
      fired = true;
    });
    await Promise.resolve();

    expect(fired).toBe(true);
  });
});
