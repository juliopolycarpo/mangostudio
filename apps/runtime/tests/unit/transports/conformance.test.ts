import { describe } from 'bun:test';
import { PassThrough } from 'node:stream';
import { RUNTIME_MAX_TRANSPORT_MESSAGE_BYTES } from '@mangostudio/shared/runtime-protocol';
import {
  clientWebSocketSink,
  connectInProcessRuntime,
  createStdioFramePort,
  createWebSocketFramePort,
  type RuntimeHost,
  RuntimeProtocolClient,
  serverWebSocketSink,
  type WebSocketFramePort,
} from '../../../src';
import { serveRuntime } from '../../../src/serve';
import {
  CONFORMANCE_HUB_VERSION,
  type ConformanceConnection,
  itBehavesLikeARuntimeTransport,
} from '../../support/transport-conformance';

/**
 * The framings that exist today, driven through one suite. A new one plugs in
 * the same way: supply a connection, a way to sever it, and a way to close it.
 * WSL and SSH are absent on purpose — they are launchers over the stdio framing
 * below, so their own integration suites test the launcher rather than a
 * framing this file already covers.
 */

describe('in-process transport conformance', () => {
  itBehavesLikeARuntimeTransport({
    async connect(host) {
      const connection = await connectInProcessRuntime(host, {
        hubVersion: CONFORMANCE_HUB_VERSION,
      });
      return {
        client: connection.client,
        host,
        // There is no wire to cut: the hub-side view of an embedded runtime
        // that went away is its client being torn down.
        drop: () => connection.client.close(),
        close: () => connection.close(),
      };
    },
  });
});

describe('stdio transport conformance', () => {
  itBehavesLikeARuntimeTransport({
    async connect(host) {
      const hubToRuntime = new PassThrough();
      const runtimeToHub = new PassThrough();

      const hubPort = createStdioFramePort({
        input: runtimeToHub,
        output: hubToRuntime,
        // The launcher wires the same signal: a pipe that closes is how the hub
        // learns a child is gone, and in-flight requests have to fail on it.
        onClosed: () => client.close(),
      });
      host.attach(
        createStdioFramePort({
          input: hubToRuntime,
          output: runtimeToHub,
          onClosed: () => undefined,
        })
      );

      const client = new RuntimeProtocolClient(hubPort, { hubVersion: CONFORMANCE_HUB_VERSION });
      host.start();
      await Promise.all([client.waitUntilReady(), host.waitUntilReady()]);

      const teardown = (): void => {
        client.close();
        host.close();
        hubToRuntime.destroy();
        runtimeToHub.destroy();
      };
      return {
        client,
        host,
        drop: () => {
          runtimeToHub.destroy(new Error('runtime pipe closed'));
        },
        close: teardown,
      };
    },
  });
});

describe('websocket transport conformance', () => {
  itBehavesLikeARuntimeTransport({
    chunked: true,
    connect: connectOverLoopbackWebSocket,
  });
});

describe('serve transport conformance', () => {
  itBehavesLikeARuntimeTransport({
    chunked: true,
    connect: connectOverServe,
  });
});

interface HubSocketData {
  port?: WebSocketFramePort;
}

/**
 * A real loopback WebSocket with the hub's own socket options, because the
 * payload limit is exactly what this transport exists to work around: a fake
 * socket would accept the 16 MiB message the chunk layer is there to prevent.
 */
async function connectOverLoopbackWebSocket(host: RuntimeHost): Promise<ConformanceConnection> {
  let client: RuntimeProtocolClient | undefined;
  const ready = Promise.withResolvers<RuntimeProtocolClient>();

  const server = Bun.serve<HubSocketData, never>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request, self) {
      if (self.upgrade(request, { data: {} })) return undefined;
      return new Response('expected a websocket upgrade', { status: 400 });
    },
    websocket: {
      maxPayloadLength: RUNTIME_MAX_TRANSPORT_MESSAGE_BYTES,
      backpressureLimit: 64 * 1024,
      closeOnBackpressureLimit: true,
      idleTimeout: 60,
      open(socket) {
        const port = createWebSocketFramePort({
          sink: serverWebSocketSink(socket),
          onClosed: () => client?.close(),
        });
        socket.data.port = port;
        client = new RuntimeProtocolClient(port, { hubVersion: CONFORMANCE_HUB_VERSION });
        ready.resolve(client);
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

  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  socket.binaryType = 'arraybuffer';
  const runtimePort = createWebSocketFramePort({ sink: clientWebSocketSink(socket) });
  socket.addEventListener('message', (event) => runtimePort.receive(event.data as ArrayBuffer));
  socket.addEventListener('close', () => runtimePort.handleSocketClosed());

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('websocket failed to open')), {
      once: true,
    });
  });

  host.attach(runtimePort);
  host.start();
  const hubClient = await ready.promise;
  await Promise.all([hubClient.waitUntilReady(), host.waitUntilReady()]);

  return {
    client: hubClient,
    host,
    // What the hub sees when the machine on the other end disappears.
    drop: () => socket.close(),
    close() {
      hubClient.close();
      host.close();
      socket.close();
      server.stop(true);
    },
  };
}

/**
 * Real `serve` fixture: the runtime listens, the hub dials with a Bearer token,
 * and both sides speak the same chunked WebSocket framing.
 */
async function connectOverServe(host: RuntimeHost): Promise<ConformanceConnection> {
  const token = 'conformance-serve-token';
  const handle = serveRuntime({
    listen: { hostname: '127.0.0.1', port: 0 },
    token,
    // The conformance suite supplies the host; serve would otherwise create one.
    createHost: () => host,
  });

  const socket = new WebSocket(`ws://127.0.0.1:${handle.port}/`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  socket.binaryType = 'arraybuffer';
  let client: RuntimeProtocolClient | undefined;
  const hubPort = createWebSocketFramePort({
    sink: clientWebSocketSink(socket),
    onClosed: () => client?.close(),
  });
  // Subscribe before the upgrade completes: the runtime starts its host in
  // `open` and the hello can race a listener attached only after `open` fires.
  client = new RuntimeProtocolClient(hubPort, { hubVersion: CONFORMANCE_HUB_VERSION });
  socket.addEventListener('message', (event) => hubPort.receive(event.data as ArrayBuffer));
  socket.addEventListener('close', () => hubPort.handleSocketClosed());

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('serve websocket failed to open')), {
      once: true,
    });
  });

  await Promise.all([client.waitUntilReady(), host.waitUntilReady()]);

  return {
    client,
    host,
    drop: () => socket.close(),
    close() {
      client?.close();
      host.close();
      socket.close();
      handle.close();
    },
  };
}
