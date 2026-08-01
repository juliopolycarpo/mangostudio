import { afterEach, describe, expect, it } from 'bun:test';
import {
  RUNTIME_CLOSE_CODES,
  RUNTIME_HEARTBEAT_TOPIC,
  RUNTIME_MAX_TRANSPORT_MESSAGE_BYTES,
  type RuntimeCapabilityManifest,
  type RuntimeEventFrame,
} from '@mangostudio/shared/runtime-protocol';
import { RuntimeHost, RuntimeProtocolClient } from '../../src';
import { connectToHub } from '../../src/connect';
import {
  createWebSocketFramePort,
  serverWebSocketSink,
  type WebSocketFramePort,
} from '../../src/transports/websocket';

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
  port?: WebSocketFramePort;
  authorized: boolean;
}

interface FakeHub {
  readonly url: string;
  readonly accepted: number;
  readonly clients: RuntimeProtocolClient[];
  readonly events: RuntimeEventFrame[];
  /** Close whatever is connected with a chosen code. */
  closeCurrent(code: number, reason: string): void;
  stop(): void;
}

const running: FakeHub[] = [];

afterEach(() => {
  for (const hub of running.splice(0)) hub.stop();
});

/**
 * The hub half, small enough to script: a bearer check on the upgrade and the
 * same chunked framing the real endpoint speaks.
 */
function startFakeHub(options: { readonly token?: string } = {}): FakeHub {
  const expected = options.token ?? VALID_TOKEN;
  const clients: RuntimeProtocolClient[] = [];
  const events: RuntimeEventFrame[] = [];
  let accepted = 0;
  let current: { close(code: number, reason: string): void } | null = null;

  const server = Bun.serve<HubSocketData, never>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request, self) {
      const authorized = request.headers.get('authorization') === `Bearer ${expected}`;
      if (self.upgrade(request, { data: { authorized } })) return undefined;
      return new Response('expected a websocket upgrade', { status: 400 });
    },
    websocket: {
      maxPayloadLength: RUNTIME_MAX_TRANSPORT_MESSAGE_BYTES,
      idleTimeout: 60,
      open(socket) {
        if (!socket.data.authorized) {
          socket.close(RUNTIME_CLOSE_CODES.UNAUTHORIZED, 'Unauthorized');
          return;
        }
        accepted += 1;
        current = socket;
        const port = createWebSocketFramePort({ sink: serverWebSocketSink(socket) });
        socket.data.port = port;
        const client = new RuntimeProtocolClient(port, { hubVersion: 'hub-test' });
        client.onEvent((event) => events.push(event));
        clients.push(client);
      },
      message(socket, message) {
        socket.data.port?.receive(message);
      },
      drain(socket) {
        socket.data.port?.handleDrain();
      },
      close(socket) {
        socket.data.port?.handleSocketClosed();
      },
    },
  });

  const hub: FakeHub = {
    url: `ws://127.0.0.1:${server.port}`,
    get accepted() {
      return accepted;
    },
    clients,
    events,
    closeCurrent(code, reason) {
      current?.close(code, reason);
    },
    stop() {
      server.stop(true);
    },
  };
  running.push(hub);
  return hub;
}

function createHost(): RuntimeHost {
  return new RuntimeHost({
    runtimeVersion: 'runtime-test',
    manifest: MANIFEST,
    handlers: new Map(),
  });
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
      createHost,
      signal: controller.signal,
    });

    await waitFor(() => hub.clients.length === 1, 'the hub to accept a connection');
    await hub.clients[0]?.waitUntilReady();
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
      createHost,
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
      createHost,
      signal: controller.signal,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });

    await waitFor(() => hub.clients.length === 1, 'the first connection');
    await hub.clients[0]?.waitUntilReady();
    hub.closeCurrent(RUNTIME_CLOSE_CODES.SUPERSEDED, 'Superseded');

    await waitFor(() => hub.clients.length === 2, 'the redial');
    await hub.clients[1]?.waitUntilReady();

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
      createHost,
      signal: controller.signal,
      sleep: (ms) => {
        delays.push(ms);
        controller.abort();
        return Promise.resolve();
      },
    });

    await waitFor(() => hub.clients.length === 1, 'the first connection');
    await hub.clients[0]?.waitUntilReady();
    hub.closeCurrent(RUNTIME_CLOSE_CODES.RATE_LIMITED, 'Rate limited');

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
      createHost,
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
});
