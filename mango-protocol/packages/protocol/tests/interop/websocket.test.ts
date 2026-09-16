/**
 * A TypeScript session and a Rust session over one WebSocket, each side taking
 * a turn at accepting the upgrade.
 *
 * The credential lives at the upgrade on this transport, so both directions
 * carry `Authorization: Bearer` and both acceptors check it before `hello`.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { Server } from 'bun';
import legacyHello from '../../../../spec/fixtures/1/legacy-hello.json';
import { CLOSE_CODES } from '../../src/close';
import type { Port } from '../../src/port';
import { Session } from '../../src/session';
import { CONFORMANCE_A } from '../../src/testing/conformance';
import {
  createWebSocketPort,
  outcomeOfBunSend,
  WEBSOCKET_SUBPROTOCOL,
  type WebSocketPortHandle,
} from '../../src/transports/websocket';
import { connectWebSocket } from '../../src/transports/websocket-client';
import {
  expectMangoPeerBehaviour,
  INTEROP_ENABLED,
  LEGACY_HELLO_CLOSE_CODE,
  oneChunk,
  PEER_TOKEN,
  type RunningPeer,
  startPeer,
} from './support';

const describeInterop = INTEROP_ENABLED ? describe : describe.skip;

const HOST = '127.0.0.1';
const BEARER = `Bearer ${PEER_TOKEN}`;

const running: RunningPeer[] = [];
const serving: Server<SocketData>[] = [];

afterEach(async () => {
  for (const peer of running.splice(0)) peer.stop();
  for (const server of serving.splice(0)) await server.stop(true);
});

describeInterop('interop: WebSocket (Rust serves, TypeScript dials)', () => {
  it('completes the handshake and serves every case', async () => {
    const peer = await startPeer(['--ws', `${HOST}:0`, '--token', PEER_TOKEN]);
    running.push(peer);

    const port = await connectWebSocket(`ws://${peer.address}`, {
      headers: { authorization: BEARER },
    });
    const session = new Session(port, { peer: CONFORMANCE_A, livenessIntervalMs: false });
    try {
      await expectMangoPeerBehaviour(session);
    } catch (cause) {
      throw new Error(`${String(cause)}\npeer said:\n${peer.diagnostics()}`, { cause });
    } finally {
      session.close(CLOSE_CODES.RELEASED, 'interop done');
    }
  }, 60_000);

  it('refuses a credential it does not know with 4401 and no hello', async () => {
    const peer = await startPeer(['--ws', `${HOST}:0`, '--token', PEER_TOKEN]);
    running.push(peer);

    const socket = await rawSocket(`ws://${peer.address}`, 'Bearer wrong');
    expect(await closeCodeOf(socket)).toBe(CLOSE_CODES.UNAUTHORIZED);
  }, 60_000);

  it('answers a runtime-protocol 1.0.1 hello with 4426', async () => {
    const peer = await startPeer(['--ws', `${HOST}:0`, '--token', PEER_TOKEN]);
    running.push(peer);

    // A raw socket with no port over it: the same frame an old binary sends,
    // as the one chunk message it fits in.
    const socket = await rawSocket(`ws://${peer.address}`, BEARER);
    const closed = closeCodeOf(socket);
    socket.send(oneChunk(legacyHello.cases[0]?.line ?? ''));
    expect(await closed).toBe(LEGACY_HELLO_CLOSE_CODE);
  }, 60_000);
});

describeInterop('interop: WebSocket (TypeScript serves, Rust dials)', () => {
  it('completes the handshake and serves every case', async () => {
    const server = new MangoServer();
    serving.push(server.server);

    const peer = await startPeer(['--connect', server.url, '--token', PEER_TOKEN]);
    running.push(peer);

    const session = new Session(await server.port, {
      peer: CONFORMANCE_A,
      livenessIntervalMs: false,
    });
    try {
      await expectMangoPeerBehaviour(session);
    } catch (cause) {
      throw new Error(`${String(cause)}\npeer said:\n${peer.diagnostics()}`, { cause });
    } finally {
      session.close(CLOSE_CODES.RELEASED, 'interop done');
    }
    // The peer's session ends with the socket, so it exits on its own.
    // Asserted after the block, not inside it: a throw in `finally` replaces
    // whatever failed above it, so a wedged peer would hide the real failure.
    expect(await peer.exited).toBe(0);
  }, 60_000);
});

/** What the upgrade hands to the socket handlers: the port built for it. */
interface SocketData {
  handle: WebSocketPortHandle | undefined;
}

/** A Bun server that accepts one Mango session, the way the guide documents. */
class MangoServer {
  readonly server: Server<SocketData>;
  readonly #ready = Promise.withResolvers<Port>();

  constructor() {
    const ready = this.#ready;
    this.server = Bun.serve<SocketData>({
      hostname: HOST,
      port: 0,
      fetch(request, server) {
        // The credential is checked at the upgrade, before any hello.
        if (request.headers.get('authorization') !== BEARER) {
          return new Response('expected Authorization: Bearer <token>', { status: 401 });
        }
        const offered = (request.headers.get('sec-websocket-protocol') ?? '')
          .split(',')
          .map((protocol) => protocol.trim());
        if (!offered.includes(WEBSOCKET_SUBPROTOCOL)) {
          return new Response(`expected the ${WEBSOCKET_SUBPROTOCOL} subprotocol`, { status: 426 });
        }
        const upgraded = server.upgrade(request, {
          data: { handle: undefined },
          headers: { 'Sec-WebSocket-Protocol': WEBSOCKET_SUBPROTOCOL },
        });
        return upgraded
          ? undefined
          : new Response('expected a WebSocket upgrade request', { status: 426 });
      },
      websocket: {
        open(socket) {
          const handle = createWebSocketPort({
            send: (message) => outcomeOfBunSend(socket.send(message)),
            close: (code, reason) => socket.close(code, reason),
          });
          socket.data.handle = handle;
          ready.resolve(handle.port);
        },
        message(socket, message) {
          socket.data.handle?.onMessage(message);
        },
        drain(socket) {
          socket.data.handle?.onDrain();
        },
        close(socket, code, reason) {
          socket.data.handle?.onClose(code, reason);
        },
      },
    });
  }

  get url(): string {
    return `ws://${HOST}:${this.server.port}`;
  }

  /** The port for the one connection the Rust peer makes. */
  get port(): Promise<Port> {
    return this.#ready.promise;
  }
}

/** An open socket offering the subprotocol, with no Mango port over it. */
function rawSocket(url: string, authorization: string): Promise<WebSocket> {
  const socket = new WebSocket(url, {
    protocols: [WEBSOCKET_SUBPROTOCOL],
    headers: { authorization },
  } as unknown as string[]);
  socket.binaryType = 'arraybuffer';
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(socket), { once: true });
    // A refused upgrade never opens; the code arrives on the close instead.
    socket.addEventListener('error', () => reject(new Error(`${url} never opened`)), {
      once: true,
    });
  });
}

/** The reason code the peer closes with. */
function closeCodeOf(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.addEventListener('close', (event) => resolve(event.code), { once: true });
  });
}
