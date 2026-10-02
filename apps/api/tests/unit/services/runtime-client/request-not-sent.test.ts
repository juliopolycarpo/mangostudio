import { describe, expect, it } from 'bun:test';
import { type Frame, type Port, type PortClosure, RemoteError } from '@mangostudio/protocol';
import { createInProcessPortPair } from '@mangostudio/protocol/in-process';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import { openHubSession } from '../../../../src/services/runtime-client/hub-session';
import {
  isRequestNotSent,
  noReplyOf,
  RuntimeRequestNotSentError,
} from '../../../../src/services/runtime-client/request-not-sent';
import { RuntimeClient } from '../../../../src/services/runtime-client/runtime-client';
import { serveFakeRuntime } from '../../../support/fake-runtime-host';
import {
  connectTestRuntime,
  FakeRuntimeDefinition,
  fixedConsent,
  TEST_RUNTIME_MANIFEST,
} from '../../../support/runtime-fixture';

/** Delivers an error response, then closes before the awaiting request resumes. */
class CloseAfterErrorPort implements Port {
  readonly #inner: Port;
  afterError: (() => void) | undefined;

  constructor(inner: Port) {
    this.#inner = inner;
  }
  send(frame: Frame): void {
    this.#inner.send(frame);
  }
  onFrame(listener: (frame: Frame) => void): () => void {
    return this.#inner.onFrame((frame) => {
      listener(frame);
      if (frame.type === 'err') this.afterError?.();
    });
  }
  onClosed(listener: (closure: PortClosure) => void): () => void {
    return this.#inner.onClosed(listener);
  }
  close(code: number, reason?: string): void {
    this.#inner.close(code, reason);
  }
}

const TURN_PARAMS = {
  sessionId: 'session-1',
  clientMessageId: 'message-1',
  input: 'hello',
  configuration: { level: 'default', routing: 'user', workspaceRoots: ['/work'] },
} as const;

describe('RuntimeRequestNotSentError', () => {
  it('is thrown, with zero runtime calls, when the session closed before the request', async () => {
    let received = 0;
    const runtime = await connectTestRuntime({
      handlers: {
        'external-agent.turn': () => {
          received += 1;
          return { nativeTurnId: 'native-1' };
        },
      },
    });
    await runtime.close();

    const error = await runtime.client.externalAgents.turn(TURN_PARAMS).catch((e: unknown) => e);

    expect(isRequestNotSent(error)).toBe(true);
    expect(error).toBeInstanceOf(RemoteError);
    expect((error as RemoteError).code).toBe('UNAVAILABLE');
    expect(received).toBe(0);
  });

  it('is not thrown when the frame was written and the session closed before the reply', async () => {
    let received = 0;
    const arrived = Promise.withResolvers<void>();
    const runtime = await connectTestRuntime({
      handlers: {
        'external-agent.turn': () => {
          received += 1;
          arrived.resolve();
          return new Promise(() => undefined);
        },
      },
    });

    const pending = runtime.client.externalAgents.turn(TURN_PARAMS).catch((e: unknown) => e);
    await arrived.promise;
    await runtime.close();
    const error = await pending;

    expect(received).toBe(1);
    expect(error).toBeInstanceOf(RemoteError);
    expect(isRequestNotSent(error)).toBe(false);
    expect(noReplyOf(error)?.reason).toBe('connection-closed');
  });

  it("tags the hub's own deadline as no-reply", async () => {
    const runtime = await connectTestRuntime({
      handlers: { 'external-agent.turn': () => new Promise(() => undefined) },
    });
    const error = await runtime.client.externalAgents
      .turn(TURN_PARAMS, { timeoutMs: 20 })
      .catch((e: unknown) => e);
    expect(noReplyOf(error)?.reason).toBe('deadline');
    await runtime.close();
  });

  it('never tags a TIMEOUT or UNAVAILABLE the runtime itself answered', async () => {
    let code = 'TIMEOUT';
    const runtime = await connectTestRuntime({
      handlers: {
        'external-agent.turn': () => {
          // Details a runtime chose, including a close code of its own.
          throw new RemoteError(code, `the runtime answered ${code}`, { closeCode: 1001 });
        },
      },
    });
    const timedOut = await runtime.client.externalAgents
      .turn(TURN_PARAMS, { timeoutMs: 5_000 })
      .catch((e: unknown) => e);
    code = 'UNAVAILABLE';
    const unavailable = await runtime.client.externalAgents
      .turn(TURN_PARAMS, { timeoutMs: 5_000 })
      .catch((e: unknown) => e);
    expect({ timedOut: noReplyOf(timedOut), unavailable: noReplyOf(unavailable) }).toEqual({
      timedOut: undefined,
      unavailable: undefined,
    });
    expect(unavailable).toBeInstanceOf(RemoteError);
    await runtime.close();
  });

  it('keeps a forged remote closeCode message-local when a real close races after the answer', async () => {
    const ports = createInProcessPortPair();
    const port = new CloseAfterErrorPort(ports.a);
    function refuseTurn(): never {
      throw new RemoteError('UNAVAILABLE', 'This input is refused.', { closeCode: 1001 });
    }
    const definition = new FakeRuntimeDefinition({
      runtimeVersion: 'runtime-test',
      manifest: TEST_RUNTIME_MANIFEST,
      consent: fixedConsent(RUNTIME_CONSENT_PRESETS.full, 'host'),
      handlers: { 'external-agent.turn': refuseTurn },
    });
    const peer = serveFakeRuntime(ports.b, definition, { livenessIntervalMs: false });
    const hub = await openHubSession(port, { hubVersion: 'hub-test', workspaceBinding: null });
    port.afterError = () => hub.close();
    let unavailable = 0;
    function recordUnavailable(): void {
      unavailable += 1;
    }
    const client = new RuntimeClient(hub, recordUnavailable);
    try {
      const error = await client.externalAgents.turn(TURN_PARAMS).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(RemoteError);
      expect((error as RemoteError).message).toBe('This input is refused.');
      expect(noReplyOf(error)).toBeUndefined();
      expect(unavailable).toBe(0);
    } finally {
      hub.close();
      peer.close();
    }
  });

  it('names the method and the expected state in its message', () => {
    const error = new RuntimeRequestNotSentError('external-agent.turn', undefined);
    expect(error.message).toContain('external-agent.turn');
    expect(error.message).toContain('expected an open session');
  });
});
