import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLOSE_CODES, type Port, Session, type SessionClosure } from '@mangostudio/protocol';
import { connectWebSocket, WEBSOCKET_SUBPROTOCOL } from '@mangostudio/protocol/ws';
import {
  RUNTIME_CONTRACT_NAME,
  RUNTIME_CONTRACT_VERSION,
  type RuntimeCapabilityManifest,
} from '@mangostudio/shared/runtime-contract';
import { RUNTIME_CONSENT_PRESETS } from '@mangostudio/shared/runtime-home';
import {
  encodeRuntimeFrameChunks,
  RUNTIME_PROTOCOL_VERSION,
} from '@mangostudio/shared/runtime-protocol';
import { staticConsentSource } from '../../src/consent-source';
import type { RuntimeHandlers } from '../../src/handlers';
import {
  bootstrapServeToken,
  readServeToken,
  writePairingToken,
  writeRuntimeSlotConfig,
  writeServeToken,
} from '../../src/runtime-home';
import {
  bearerToken,
  isLoopbackHostname,
  parseListenAddress,
  serveRuntime,
  tokensEqual,
} from '../../src/serve';
import { createRuntimeEventRelay, type RuntimeHostDefinition } from '../../src/session';
import { FakeRuntimeHandlers } from '../support/fake-runtime-handlers';

const TOKEN = 'serve-secret';

const SERVE_TEST_MANIFEST: RuntimeCapabilityManifest = {
  platform: 'test',
  arch: 'test',
  pathStyle: 'posix',
  homeDir: '/tmp',
  shells: ['bash'],
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

/**
 * A host definition with no services behind it.
 *
 * `serve` only ever binds a definition to a socket, so what the handlers do is
 * irrelevant here; what matters is that the definition announces a manifest and
 * that its teardown is observable, which is what every supersede and stop case
 * below waits on.
 */
class FakeRuntimeDefinition implements RuntimeHostDefinition {
  readonly runtimeVersion = 'serve-test';
  readonly handlers: RuntimeHandlers = new FakeRuntimeHandlers().map;
  readonly consent = staticConsentSource(RUNTIME_CONSENT_PRESETS.full, 'host');
  readonly events = createRuntimeEventRelay();
  readonly isUpdateActive = (): boolean => false;
  readonly #release: () => void | Promise<void>;

  constructor(release?: () => void | Promise<void>) {
    this.#release = release ?? ((): void => undefined);
  }

  manifest(): RuntimeCapabilityManifest {
    return SERVE_TEST_MANIFEST;
  }

  onClose(): void | Promise<void> {
    return this.#release();
  }
}

/** The hub half of a Direct URL connection, over a real loopback socket. */
class FakeHubPeer {
  readonly session: Session;
  readonly #closure = Promise.withResolvers<SessionClosure>();

  constructor(port: Port) {
    this.session = new Session(port, {
      peer: { name: 'serve-test-hub', version: 'hub-test', role: 'hub' },
      capabilities: { contracts: { [RUNTIME_CONTRACT_NAME]: RUNTIME_CONTRACT_VERSION } },
      handshakeTimeoutMs: 10_000,
    });
    this.session.onClose((closure) => this.#closure.resolve(closure));
  }

  static async dial(port: number): Promise<FakeHubPeer> {
    return new FakeHubPeer(
      await connectWebSocket(serveUrl(port), { headers: { authorization: `Bearer ${TOKEN}` } })
    );
  }

  /** How the runtime ended the session. */
  get closure(): Promise<SessionClosure> {
    return this.#closure.promise;
  }

  close(): void {
    this.session.close();
  }
}

const homes: string[] = [];
const handles: Array<{ close(): void | Promise<void> }> = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.allSettled(handles.splice(0).map((handle) => handle.close()));
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function isolatedEnv(): Promise<NodeJS.ProcessEnv> {
  const home = await mkdtemp(join(tmpdir(), 'mango-serve-'));
  homes.push(home);
  return { MANGO_HOME: home };
}

function serveUrl(port: number): string {
  return `ws://127.0.0.1:${port}/`;
}

/** A hub socket that never speaks the protocol, for the transport-level cases. */
function rawHubSocket(port: number, protocols?: readonly string[]): WebSocket {
  const socket = new WebSocket(serveUrl(port), {
    headers: { Authorization: `Bearer ${TOKEN}` },
    ...(protocols ? { protocols } : {}),
  } as unknown as string[]);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('error', () => undefined);
  sockets.push(socket);
  return socket;
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('close', () => reject(new Error('socket closed before it opened')), {
      once: true,
    });
  });
}

function closeCodeOf(socket: WebSocket): Promise<number> {
  return new Promise<number>((resolve) => {
    socket.addEventListener('close', (event) => resolve((event as CloseEvent).code), {
      once: true,
    });
  });
}

describe('parseListenAddress', () => {
  it('defaults a bare port to loopback', () => {
    expect(parseListenAddress('9876')).toEqual({ hostname: '127.0.0.1', port: 9876 });
  });

  it('accepts host:port and an ephemeral port', () => {
    expect(parseListenAddress('0.0.0.0:0')).toEqual({ hostname: '0.0.0.0', port: 0 });
  });

  it('rejects a missing or non-numeric port', () => {
    expect(parseListenAddress('127.0.0.1')).toBeNull();
    expect(parseListenAddress('')).toBeNull();
    expect(parseListenAddress('host:abc')).toBeNull();
  });
});

describe('loopback and bearer helpers', () => {
  it('recognises loopback hosts', () => {
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('::1')).toBe(true);
    expect(isLoopbackHostname('0.0.0.0')).toBe(false);
  });

  it('parses bearer headers and compares tokens in constant time', () => {
    expect(bearerToken('Bearer secret')).toBe('secret');
    expect(bearerToken('bearer secret')).toBe('secret');
    expect(bearerToken('Basic secret')).toBeNull();
    expect(tokensEqual('abc', 'abc')).toBe(true);
    expect(tokensEqual('abc', 'abd')).toBe(false);
    expect(tokensEqual('abc', 'abcd')).toBe(false);
  });
});

describe('serveRuntime', () => {
  function listen(createHost: () => RuntimeHostDefinition, signal?: AbortSignal) {
    const handle = serveRuntime({
      listen: { hostname: '127.0.0.1', port: 0 },
      token: TOKEN,
      createHost,
      ...(signal ? { signal } : {}),
    });
    handles.push(handle);
    return handle;
  }

  it('exposes only status and version on /health', async () => {
    const previousVersion = process.env.VERSION;
    process.env.VERSION = '1.2.3-serve';
    try {
      const handle = listen(() => new FakeRuntimeDefinition());

      const response = await fetch(`http://127.0.0.1:${handle.port}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok', version: '1.2.3-serve' });
    } finally {
      if (previousVersion === undefined) delete process.env.VERSION;
      else process.env.VERSION = previousVersion;
    }
  });

  it('stops immediately when the abort signal is already fired', async () => {
    const controller = new AbortController();
    controller.abort();
    const handle = listen(() => new FakeRuntimeDefinition(), controller.signal);
    await handle.stopped;
  });

  it('does not report stopped until asynchronous session cleanup finishes', async () => {
    const closeStarted = Promise.withResolvers<void>();
    const releaseClose = Promise.withResolvers<void>();
    const hostCreated = Promise.withResolvers<void>();
    const handle = listen(() => {
      hostCreated.resolve();
      return new FakeRuntimeDefinition(async () => {
        closeStarted.resolve();
        await releaseClose.promise;
      });
    });

    await opened(rawHubSocket(handle.port));
    await hostCreated.promise;

    let stopped = false;
    void handle.stopped.then(() => {
      stopped = true;
    });
    const closing = handle.close();
    await closeStarted.promise;
    await Bun.sleep(0);
    expect(stopped).toBe(false);

    releaseClose.resolve();
    await closing;
    expect(stopped).toBe(true);
  });

  it('reaps a definition created by an open callback that loses the stop race', async () => {
    const controller = new AbortController();
    const hostCreated = Promise.withResolvers<void>();
    const closeStarted = Promise.withResolvers<void>();
    const releaseClose = Promise.withResolvers<void>();
    const handle = listen(() => {
      const definition = new FakeRuntimeDefinition(async () => {
        closeStarted.resolve();
        await releaseClose.promise;
      });
      hostCreated.resolve();
      controller.abort();
      return definition;
    }, controller.signal);

    rawHubSocket(handle.port);
    await hostCreated.promise;
    await closeStarted.promise;

    let stopped = false;
    void handle.stopped.then(() => {
      stopped = true;
    });
    await Bun.sleep(0);
    expect(stopped).toBe(false);

    releaseClose.resolve();
    await handle.stopped;
    expect(stopped).toBe(true);
  });

  it('refuses upgrades without a matching bearer token', async () => {
    const handle = listen(() => new FakeRuntimeDefinition());

    const missing = await fetch(`http://127.0.0.1:${handle.port}/`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });
    expect(missing.status).toBe(401);

    const wrong = await fetch(`http://127.0.0.1:${handle.port}/`, {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        Authorization: 'Bearer other',
      },
    });
    expect(wrong.status).toBe(401);
  });

  it('runs asynchronous definition cleanup after the socket closes', async () => {
    const closeStarted = Promise.withResolvers<void>();
    const releaseClose = Promise.withResolvers<void>();
    const closeFinished = Promise.withResolvers<void>();
    const handle = listen(
      () =>
        new FakeRuntimeDefinition(async () => {
          closeStarted.resolve();
          await releaseClose.promise;
          closeFinished.resolve();
        })
    );

    const socket = rawHubSocket(handle.port);
    await opened(socket);

    socket.close();
    await closeStarted.promise;
    let finished = false;
    void closeFinished.promise.then(() => {
      finished = true;
    });
    await Bun.sleep(0);
    expect(finished).toBe(false);

    releaseClose.resolve();
    await closeFinished.promise;
    expect(finished).toBe(true);
  });

  it('echoes the mango.v1 subprotocol only to a hub that offered it', async () => {
    const handle = listen(() => new FakeRuntimeDefinition());

    const offering = rawHubSocket(handle.port, [WEBSOCKET_SUBPROTOCOL]);
    await opened(offering);
    expect(offering.protocol).toBe(WEBSOCKET_SUBPROTOCOL);

    // A 1.0.1 hub offers none, and an acceptor may not select one that was
    // never listed: a WHATWG client fails the connection when it does.
    const silent = rawHubSocket(handle.port);
    await opened(silent);
    expect(silent.protocol).toBe('');
  });

  it('closes a hub that announces itself on the 1.0.1 wire', async () => {
    const handle = listen(() => new FakeRuntimeDefinition());

    const socket = rawHubSocket(handle.port);
    await opened(socket);
    const closed = closeCodeOf(socket);
    for (const chunk of encodeRuntimeFrameChunks({
      type: 'hello',
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeVersion: '1.0.1',
      manifest: SERVE_TEST_MANIFEST,
    })) {
      socket.send(chunk);
    }

    expect(await closed).toBe(CLOSE_CODES.PROTOCOL_MISMATCH);
  });

  it('closes the previous hub connection as superseded', async () => {
    const handle = listen(() => new FakeRuntimeDefinition());

    const first = await FakeHubPeer.dial(handle.port);
    await first.session.ready;

    const second = await FakeHubPeer.dial(handle.port);
    await second.session.ready;

    expect(await first.closure).toMatchObject({ code: CLOSE_CODES.SUPERSEDED });
    second.close();
  });

  it('waits for superseded definition cleanup before the replacement says hello', async () => {
    const closeStarted = Promise.withResolvers<void>();
    const releaseClose = Promise.withResolvers<void>();
    let definitions = 0;
    const handle = listen(() => {
      definitions += 1;
      return definitions === 1
        ? new FakeRuntimeDefinition(async () => {
            closeStarted.resolve();
            await releaseClose.promise;
          })
        : new FakeRuntimeDefinition();
    });

    const first = await FakeHubPeer.dial(handle.port);
    await first.session.ready;

    const second = await FakeHubPeer.dial(handle.port);
    await closeStarted.promise;

    let replacementReady = false;
    void second.session.ready.then(() => {
      replacementReady = true;
    });
    await Bun.sleep(0);
    expect(replacementReady).toBe(false);

    releaseClose.resolve();
    await second.session.ready;
    expect(replacementReady).toBe(true);
    second.close();
  });

  it('completes a hub handshake over the authenticated socket', async () => {
    const handle = listen(() => new FakeRuntimeDefinition());

    const hub = await FakeHubPeer.dial(handle.port);
    const remote = await hub.session.ready;

    expect(remote.peer.version).toBe('serve-test');
    expect(remote.peer.role).toBe('runtime');
    expect(remote.capabilities).toMatchObject({
      platform: 'test',
      contracts: { [RUNTIME_CONTRACT_NAME]: RUNTIME_CONTRACT_VERSION },
    });
    hub.close();
  });

  it('releases a connected hub with 4000 when the runtime stops', async () => {
    const handle = listen(() => new FakeRuntimeDefinition());

    const hub = await FakeHubPeer.dial(handle.port);
    await hub.session.ready;

    await handle.close();
    expect(await hub.closure).toMatchObject({ code: CLOSE_CODES.RELEASED });
  });
});

describe('serve token bootstrap', () => {
  it('generates and stores a serve token without disturbing the pairing token', async () => {
    const env = await isolatedEnv();
    await writePairingToken('remote', 'pairing-secret', env);
    const { token } = await bootstrapServeToken('remote', env);

    expect(token.length).toBeGreaterThan(20);
    expect(await readServeToken('remote', env)).toBe(token);
    await writeServeToken('remote', 'rotated-serve', env);
    expect(await readServeToken('remote', env)).toBe('rotated-serve');
  });
});

describe('pending setup gate', () => {
  it('records a pending setup state that the CLI can refuse on', async () => {
    const env = await isolatedEnv();
    await writeRuntimeSlotConfig('remote', { setup: { state: 'pending' } }, env);
    const { readRuntimeSlotConfig } = await import('../../src/runtime-home');
    expect((await readRuntimeSlotConfig('remote', env)).setup.state).toBe('pending');
  });
});
