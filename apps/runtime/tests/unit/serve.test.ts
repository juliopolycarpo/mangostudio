import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RUNTIME_CLOSE_CODES,
  RUNTIME_PROTOCOL_VERSION,
} from '@mangostudio/shared/runtime-protocol';
import {
  clientWebSocketSink,
  createWebSocketFramePort,
  RuntimeHost,
  RuntimeProtocolClient,
} from '../../src';
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

const homes: string[] = [];
const handles: Array<{ close(): void | Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.close()));
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function isolatedEnv(): Promise<NodeJS.ProcessEnv> {
  const home = await mkdtemp(join(tmpdir(), 'mango-serve-'));
  homes.push(home);
  return { MANGO_HOME: home };
}

function createTestHost(onClose?: () => void | Promise<void>): RuntimeHost {
  return new RuntimeHost({
    runtimeVersion: 'serve-test',
    manifest: {
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
    },
    handlers: new Map(),
    ...(onClose ? { onClose } : {}),
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
  it('exposes only status and version on /health', async () => {
    const previousVersion = process.env.VERSION;
    process.env.VERSION = '1.2.3-serve';
    try {
      const handle = serveRuntime({
        listen: { hostname: '127.0.0.1', port: 0 },
        token: 'serve-secret',
        createHost: createTestHost,
      });
      handles.push(handle);

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
    const handle = serveRuntime({
      listen: { hostname: '127.0.0.1', port: 0 },
      token: 'serve-secret',
      createHost: createTestHost,
      signal: controller.signal,
    });
    handles.push(handle);
    await handle.stopped;
  });

  it('does not report stopped until asynchronous session cleanup finishes', async () => {
    const closeStarted = Promise.withResolvers<void>();
    const releaseClose = Promise.withResolvers<void>();
    const hostCreated = Promise.withResolvers<void>();
    const handle = serveRuntime({
      listen: { hostname: '127.0.0.1', port: 0 },
      token: 'serve-secret',
      createHost: () => {
        hostCreated.resolve();
        return createTestHost(async () => {
          closeStarted.resolve();
          await releaseClose.promise;
        });
      },
    });
    handles.push(handle);

    const socket = new WebSocket(`ws://127.0.0.1:${handle.port}/`, {
      headers: { Authorization: 'Bearer serve-secret' },
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('socket failed')), { once: true });
    });
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
    socket.close();
  });

  it('reaps a host created by an open callback that loses the stop race', async () => {
    const controller = new AbortController();
    const hostCreated = Promise.withResolvers<void>();
    const closeStarted = Promise.withResolvers<void>();
    const releaseClose = Promise.withResolvers<void>();
    const handle = serveRuntime({
      listen: { hostname: '127.0.0.1', port: 0 },
      token: 'serve-secret',
      signal: controller.signal,
      createHost: () => {
        const host = createTestHost(async () => {
          closeStarted.resolve();
          await releaseClose.promise;
        });
        hostCreated.resolve();
        controller.abort();
        return host;
      },
    });
    handles.push(handle);

    const socket = new WebSocket(`ws://127.0.0.1:${handle.port}/`, {
      headers: { Authorization: 'Bearer serve-secret' },
    });
    socket.addEventListener('error', () => undefined);
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
    socket.close();
  });

  it('refuses upgrades without a matching bearer token', async () => {
    const handle = serveRuntime({
      listen: { hostname: '127.0.0.1', port: 0 },
      token: 'serve-secret',
      createHost: createTestHost,
    });
    handles.push(handle);

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

  it('runs asynchronous host cleanup after the socket closes', async () => {
    const closeStarted = Promise.withResolvers<void>();
    const releaseClose = Promise.withResolvers<void>();
    const closeFinished = Promise.withResolvers<void>();
    const handle = serveRuntime({
      listen: { hostname: '127.0.0.1', port: 0 },
      token: 'serve-secret',
      createHost: () =>
        createTestHost(async () => {
          closeStarted.resolve();
          await releaseClose.promise;
          closeFinished.resolve();
        }),
    });
    handles.push(handle);

    const socket = new WebSocket(`ws://127.0.0.1:${handle.port}/`, {
      headers: { Authorization: 'Bearer serve-secret' },
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('socket failed')), { once: true });
    });

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

  it('closes the previous hub connection as superseded', async () => {
    const handle = serveRuntime({
      listen: { hostname: '127.0.0.1', port: 0 },
      token: 'serve-secret',
      createHost: createTestHost,
    });
    handles.push(handle);

    const first = new WebSocket(`ws://127.0.0.1:${handle.port}/`, {
      headers: { Authorization: 'Bearer serve-secret' },
    });
    first.binaryType = 'arraybuffer';
    await new Promise<void>((resolve, reject) => {
      first.addEventListener('open', () => resolve(), { once: true });
      first.addEventListener('error', () => reject(new Error('first socket failed')), {
        once: true,
      });
    });

    const firstClosed = new Promise<number>((resolve) => {
      first.addEventListener('close', (event) => resolve((event as CloseEvent).code), {
        once: true,
      });
    });

    const second = new WebSocket(`ws://127.0.0.1:${handle.port}/`, {
      headers: { Authorization: 'Bearer serve-secret' },
    });
    second.binaryType = 'arraybuffer';
    await new Promise<void>((resolve, reject) => {
      second.addEventListener('open', () => resolve(), { once: true });
      second.addEventListener('error', () => reject(new Error('second socket failed')), {
        once: true,
      });
    });

    expect(await firstClosed).toBe(RUNTIME_CLOSE_CODES.SUPERSEDED);
    second.close();
  });

  it('waits for superseded host cleanup before starting the replacement host', async () => {
    const closeStarted = Promise.withResolvers<void>();
    const releaseClose = Promise.withResolvers<void>();
    let hostNumber = 0;
    const handle = serveRuntime({
      listen: { hostname: '127.0.0.1', port: 0 },
      token: 'serve-secret',
      createHost: () => {
        hostNumber += 1;
        return createTestHost(
          hostNumber === 1
            ? async () => {
                closeStarted.resolve();
                await releaseClose.promise;
              }
            : undefined
        );
      },
    });
    handles.push(handle);

    const first = new WebSocket(`ws://127.0.0.1:${handle.port}/`, {
      headers: { Authorization: 'Bearer serve-secret' },
    });
    await new Promise<void>((resolve, reject) => {
      first.addEventListener('open', () => resolve(), { once: true });
      first.addEventListener('error', () => reject(new Error('first socket failed')), {
        once: true,
      });
    });

    const second = new WebSocket(`ws://127.0.0.1:${handle.port}/`, {
      headers: { Authorization: 'Bearer serve-secret' },
    });
    second.binaryType = 'arraybuffer';
    const port = createWebSocketFramePort({ sink: clientWebSocketSink(second) });
    const client = new RuntimeProtocolClient(port, {
      hubVersion: 'hub-test',
      handshakeTimeoutMs: 5_000,
    });
    second.addEventListener('message', (event) => port.receive(event.data as ArrayBuffer));
    second.addEventListener('close', () => port.handleSocketClosed());
    await new Promise<void>((resolve, reject) => {
      second.addEventListener('open', () => resolve(), { once: true });
      second.addEventListener('error', () => reject(new Error('second socket failed')), {
        once: true,
      });
    });
    await closeStarted.promise;

    let replacementReady = false;
    void client.waitUntilReady().then(() => {
      replacementReady = true;
    });
    await Bun.sleep(0);
    expect(replacementReady).toBe(false);

    releaseClose.resolve();
    await client.waitUntilReady();
    expect(replacementReady).toBe(true);
    client.close();
    second.close();
    first.close();
  });

  it('completes a hub handshake over the authenticated socket', async () => {
    const handle = serveRuntime({
      listen: { hostname: '127.0.0.1', port: 0 },
      token: 'serve-secret',
      createHost: createTestHost,
    });
    handles.push(handle);

    const socket = new WebSocket(`ws://127.0.0.1:${handle.port}/`, {
      headers: { Authorization: 'Bearer serve-secret' },
    });
    socket.binaryType = 'arraybuffer';
    const port = createWebSocketFramePort({ sink: clientWebSocketSink(socket) });
    const client = new RuntimeProtocolClient(port, {
      hubVersion: 'hub-test',
      handshakeTimeoutMs: 5_000,
    });
    socket.addEventListener('message', (event) => port.receive(event.data as ArrayBuffer));
    socket.addEventListener('close', () => port.handleSocketClosed());

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('socket failed')), { once: true });
    });

    await client.waitUntilReady();
    expect(client.runtimeVersion).toBe('serve-test');
    expect(RUNTIME_PROTOCOL_VERSION).toBeTruthy();
    client.close();
    socket.close();
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
