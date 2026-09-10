import { afterEach, describe, expect, it } from 'bun:test';
import { CLOSE_CODES, type EventFrame, Session } from '@mangostudio/protocol';
import {
  createWebSocketPort,
  outcomeOfBunSend,
  WEBSOCKET_SUBPROTOCOL,
  type WebSocketPortHandle,
} from '@mangostudio/protocol/ws';
import {
  RUNTIME_CONTRACT_NAME,
  RUNTIME_CONTRACT_VERSION,
  RUNTIME_HEARTBEAT_TOPIC,
  type RuntimeCapabilityManifest,
  RuntimeCapabilityManifestSchema,
} from '@mangostudio/shared/runtime-contract';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import type { Server, ServerWebSocket } from 'bun';
import Value from 'typebox/value';
import { connectToHub } from '../../src/connect';
import { staticConsentSource } from '../../src/consent-source';
import { createRuntimeEventRelay, type RuntimeHostDefinition } from '../../src/session';
import { FakeRuntimeHandlers } from '../support/fake-runtime-handlers';

const MANIFEST: RuntimeCapabilityManifest = {
  platform: 'test',
  arch: 'test',
  pathStyle: 'posix',
  homeDir: '/home/test',
  shells: [],
  git: { available: false },
  features: {
    tools: true,
    git: false,
    probing: false,
    mcp: false,
    library: false,
    checkpoints: false,
  },
};

const VALID_TOKEN = 'mrt_selector.secret';

interface HubSocketData {
  readonly authorized: boolean;
  handle?: WebSocketPortHandle;
}

/**
 * The hub half, small enough to script: a bearer check and the subprotocol
 * echo on the upgrade, then one SDK session per accepted socket.
 *
 * @example
 * const hub = new FakeHub();
 * await hub.manifestOf(0);
 */
class FakeHub {
  readonly sessions: Session[] = [];
  readonly events: EventFrame[] = [];
  readonly #server: Server<HubSocketData>;
  #current: ServerWebSocket<HubSocketData> | null = null;

  constructor(options: { readonly token?: string; readonly upgrade?: boolean } = {}) {
    const expected = `Bearer ${options.token ?? VALID_TOKEN}`;
    this.#server = Bun.serve<HubSocketData, never>({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request, server) => {
        if (options.upgrade === false) {
          // Accept TCP and then say nothing: `connectWebSocket` only settles
          // on open, error, or close, so this is the stall a dial deadline
          // has to end.
          return new Promise<Response>(() => undefined);
        }
        const authorized = request.headers.get('authorization') === expected;
        const upgraded = server.upgrade(request, {
          data: { authorized },
          ...(offersMangoSubprotocol(request)
            ? { headers: { 'Sec-WebSocket-Protocol': WEBSOCKET_SUBPROTOCOL } }
            : {}),
        });
        return upgraded ? undefined : new Response('expected a websocket upgrade', { status: 400 });
      },
      websocket: {
        open: (socket) => this.#accept(socket),
        message: (socket, message) => socket.data.handle?.onMessage(message),
        drain: (socket) => socket.data.handle?.onDrain(),
        close: (socket, code, reason) => socket.data.handle?.onClose(code, reason),
      },
    });
  }

  get url(): string {
    return `ws://127.0.0.1:${this.#server.port}`;
  }

  /** How many upgrades got past the bearer check. */
  get accepted(): number {
    return this.sessions.length;
  }

  /**
   * The manifest the nth accepted runtime announced, once both hellos crossed.
   *
   * Checked rather than trusted: `hello.capabilities` is an open object, so a
   * peer that speaks the wire without being a MangoStudio runtime has to fail
   * here rather than at the first method call.
   */
  async manifestOf(index: number): Promise<RuntimeCapabilityManifest> {
    const session = this.sessions[index];
    if (!session) {
      throw new Error(
        `Hub accepted ${this.sessions.length} connections; expected at least ${index + 1}.`
      );
    }
    const remote = await session.ready;
    if (!Value.Check(RuntimeCapabilityManifestSchema, remote.capabilities)) {
      throw new Error(
        `Runtime announced ${JSON.stringify(remote.capabilities)}; expected a RuntimeCapabilityManifest in hello.capabilities.`
      );
    }
    return remote.capabilities;
  }

  /** Closes whatever is connected with a chosen code, the way the hub would. */
  closeCurrent(code: number, reason: string): void {
    this.#current?.close(code, reason);
  }

  stop(): void {
    void this.#server.stop(true);
  }

  #accept(socket: ServerWebSocket<HubSocketData>): void {
    if (!socket.data.authorized) {
      socket.close(CLOSE_CODES.UNAUTHORIZED, 'Unauthorized');
      return;
    }
    this.#current = socket;
    const handle = createWebSocketPort({
      send: (bytes) => outcomeOfBunSend(socket.send(bytes)),
      close: (code, reason) => socket.close(code, reason),
    });
    socket.data.handle = handle;
    const session = new Session(handle.port, {
      peer: { name: 'fake-hub', version: 'hub-test', role: 'hub' },
      capabilities: { contracts: { [RUNTIME_CONTRACT_NAME]: RUNTIME_CONTRACT_VERSION } },
    });
    session.onEvent((event) => this.events.push(event));
    this.sessions.push(session);
  }
}

/** RFC 6455: an acceptor may only name a subprotocol the dialler offered. */
function offersMangoSubprotocol(request: Request): boolean {
  return (request.headers.get('sec-websocket-protocol') ?? '')
    .split(',')
    .some((protocol) => protocol.trim() === WEBSOCKET_SUBPROTOCOL);
}

/** A runtime that announces a manifest and answers nothing in particular. */
class FakeRuntimeDefinition implements RuntimeHostDefinition {
  readonly runtimeVersion = 'runtime-test';
  readonly manifest = () => MANIFEST;
  readonly handlers = new FakeRuntimeHandlers().map;
  readonly consent = staticConsentSource(RUNTIME_CONSENT_PRESETS.full, 'host');
  readonly isUpdateActive = () => false;
  readonly events = createRuntimeEventRelay();
  readonly onClose = () => undefined;
}

const running: FakeHub[] = [];

afterEach(() => {
  for (const hub of running.splice(0)) hub.stop();
});

function startFakeHub(
  options: { readonly token?: string; readonly upgrade?: boolean } = {}
): FakeHub {
  const hub = new FakeHub(options);
  running.push(hub);
  return hub;
}

function createDefinition(): RuntimeHostDefinition {
  return new FakeRuntimeDefinition();
}

/** Resolves once `predicate` holds, so tests never race a real interval. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

describe('runtime connect loop', () => {
  it('dials the hub, handshakes, and publishes a heartbeat', async () => {
    const hub = startFakeHub();
    const controller = new AbortController();
    const loop = connectToHub({
      hubUrl: hub.url,
      token: VALID_TOKEN,
      createDefinition,
      signal: controller.signal,
    });

    await waitFor(() => hub.accepted === 1, 'the hub to accept a connection');
    // `contracts` rides in the same open object; the manifest members are the point.
    expect(await hub.manifestOf(0)).toMatchObject(MANIFEST);
    await waitFor(
      () => hub.events.some((event) => event.topic === RUNTIME_HEARTBEAT_TOPIC),
      'a heartbeat event'
    );

    controller.abort();
    expect(await loop).toEqual({ reason: 'stopped' });
  });

  it('stops on a refused credential instead of retrying into a wall', async () => {
    const hub = startFakeHub({ token: 'mrt_other.secret' });
    const delays: number[] = [];

    const outcome = await connectToHub({
      hubUrl: hub.url,
      token: VALID_TOKEN,
      createDefinition,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });

    expect(outcome.reason).toBe('refused');
    expect(outcome.message).toContain('pairing token');
    // Not one retry: the answer cannot change without a person issuing a token.
    expect(delays).toEqual([]);
    expect(hub.accepted).toBe(0);
  });

  it('redials after a close it can recover from', async () => {
    const hub = startFakeHub();
    const controller = new AbortController();
    const delays: number[] = [];
    const loop = connectToHub({
      hubUrl: hub.url,
      token: VALID_TOKEN,
      createDefinition,
      signal: controller.signal,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });

    await waitFor(() => hub.accepted === 1, 'the first connection');
    await hub.manifestOf(0);
    hub.closeCurrent(CLOSE_CODES.RELEASED, 'Released');

    await waitFor(() => hub.accepted === 2, 'the redial');
    await hub.manifestOf(1);

    controller.abort();
    await loop;
    expect(delays).toHaveLength(1);
    // A connection that served resets the backoff, so the first wait is the
    // base delay rather than wherever a previous failure run had reached.
    expect(delays[0]).toBeLessThanOrEqual(1_000);
  });

  it('waits out a rate-limited close instead of coming straight back', async () => {
    const hub = startFakeHub();
    const controller = new AbortController();
    const delays: number[] = [];
    const loop = connectToHub({
      hubUrl: hub.url,
      token: VALID_TOKEN,
      createDefinition,
      signal: controller.signal,
      sleep: (ms) => {
        delays.push(ms);
        controller.abort();
        return Promise.resolve();
      },
    });

    await waitFor(() => hub.accepted === 1, 'the first connection');
    await hub.manifestOf(0);
    hub.closeCurrent(CLOSE_CODES.RATE_LIMITED, 'Rate limited');

    await loop;
    expect(delays).toEqual([30_000]);
  });

  it('backs off further with each failure that never reached the hub', async () => {
    const controller = new AbortController();
    const delays: number[] = [];
    // Nothing is listening on this port, so every attempt fails the same way.
    const loop = connectToHub({
      hubUrl: 'ws://127.0.0.1:1/api/runtime',
      token: VALID_TOKEN,
      createDefinition,
      signal: controller.signal,
      sleep: (ms) => {
        delays.push(ms);
        if (delays.length >= 3) controller.abort();
        return Promise.resolve();
      },
    });

    await loop;
    // Assert the tier each delay was drawn from, not a strict ordering between
    // them: full jitter makes the windows [500,1000], [1000,2000], [2000,4000],
    // which touch at their boundaries, so two adjacent delays can legitimately
    // come out equal.
    expect(delays).toHaveLength(3);
    expect(delays[0]).toBeWithin(500, 1_000 + 1);
    expect(delays[1]).toBeWithin(1_000, 2_000 + 1);
    expect(delays[2]).toBeWithin(2_000, 4_000 + 1);
  });

  it('stops when superseded rather than taking the environment back', async () => {
    const hub = startFakeHub();
    const delays: number[] = [];
    const loop = connectToHub({
      hubUrl: hub.url,
      token: VALID_TOKEN,
      createDefinition,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });

    await waitFor(() => hub.accepted === 1, 'the first connection');
    await hub.manifestOf(0);
    hub.closeCurrent(CLOSE_CODES.SUPERSEDED, 'Superseded');

    const outcome = await loop;
    // Redialing here is what makes two processes trade the environment back and
    // forth forever, dropping in-flight calls on every handover.
    expect(outcome.reason).toBe('refused');
    expect(outcome.message).toContain('pairing token');
    expect(delays).toEqual([]);
    expect(hub.accepted).toBe(1);
  });

  it('names the binary, not the environment, when the protocol is refused', async () => {
    const hub = startFakeHub();
    const loop = connectToHub({ hubUrl: hub.url, token: VALID_TOKEN, createDefinition });

    await waitFor(() => hub.accepted === 1, 'the first connection');
    await hub.manifestOf(0);
    hub.closeCurrent(CLOSE_CODES.PROTOCOL_MISMATCH, 'Protocol version unsupported');

    const outcome = await loop;
    expect(outcome.reason).toBe('refused');
    expect(outcome.message).toContain('Update the runtime');
  });

  it('aborts a dial that never upgrades so the reconnect loop can start', async () => {
    const hub = startFakeHub({ upgrade: false });
    const controller = new AbortController();
    const delays: number[] = [];
    const logs: string[] = [];
    const loop = connectToHub({
      hubUrl: hub.url,
      token: VALID_TOKEN,
      createDefinition,
      signal: controller.signal,
      handshakeTimeoutMs: 50,
      log: (message) => logs.push(message),
      sleep: (ms) => {
        delays.push(ms);
        controller.abort();
        return Promise.resolve();
      },
    });

    await loop;
    expect(delays).toHaveLength(1);
    expect(logs.join('\n')).toContain('did not accept a WebSocket');
  });

  it('gives up the backoff as soon as the signal aborts', async () => {
    const controller = new AbortController();
    let sleeping = false;
    const loop = connectToHub({
      // Nothing listening, so the loop reaches its backoff immediately.
      hubUrl: 'ws://127.0.0.1:1/api/runtime',
      token: VALID_TOKEN,
      createDefinition,
      signal: controller.signal,
      // A sleep that never resolves on its own: only the abort can end it, so
      // a loop that does not race the signal hangs this test rather than
      // quietly taking a minute longer than a shutdown deadline allows.
      sleep: () => {
        sleeping = true;
        return new Promise<void>(() => undefined);
      },
    });

    await waitFor(() => sleeping, 'the loop to reach its backoff');
    controller.abort();
    expect(await loop).toEqual({ reason: 'stopped' });
  });
});
