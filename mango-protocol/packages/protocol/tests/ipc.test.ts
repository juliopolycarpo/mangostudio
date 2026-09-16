import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { statSync } from 'node:fs';
import { rename, stat } from 'node:fs/promises';
import {
  connect as connectSocket,
  createServer,
  type IpcSocketConnectOpts,
  type Socket,
} from 'node:net';
import { CLOSE_CODES } from '../src/close';
import { RESERVED_ERROR_CODES } from '../src/errors';
import type { Port } from '../src/port';
import type { Frame } from '../src/schemas/frames';
import { Session, type SessionOptions } from '../src/session';
import {
  CONFORMANCE_A,
  CONFORMANCE_B,
  CONFORMANCE_HANDLERS,
  type ConformanceFixture,
  itBehavesLikeAMangoTransport,
} from '../src/testing/conformance';
import { rejectionOf } from '../src/testing/rejection';
import { connectIpc, ipcPath, ipcSocketPort, listenIpc } from '../src/transports/ipc';

const WINDOWS = process.platform === 'win32';

let addresses = 0;

/** A fresh address per connection, so parallel cases never share a listener. */
function nextPath(): string {
  addresses += 1;
  return ipcPath(`mango-protocol-test-${process.pid}-${addresses}`);
}

/** The port of the next accepted connection. */
function acceptOne(): { readonly accepted: Promise<Port>; accept: (port: Port) => void } {
  let accept: (port: Port) => void = () => undefined;
  const accepted = new Promise<Port>((resolve) => {
    accept = resolve;
  });
  return { accepted, accept };
}

/**
 * A connected socket with no port on it. `drain` discards what the far side
 * writes, for a fixture that only ever writes; a socket handed to
 * `ipcSocketPort` must not be drained, or the port would never see a frame.
 */
function rawConnect(
  path: string,
  drain = false,
  extra: Omit<IpcSocketConnectOpts, 'path'> = {}
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket({ ...extra, path });
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.removeListener('error', reject);
      if (drain) socket.resume();
      resolve(socket);
    });
  });
}

const fixture: ConformanceFixture = {
  async connect(aOptions: SessionOptions, bOptions: SessionOptions) {
    const path = nextPath();
    const { accepted, accept } = acceptOne();
    const server = await listenIpc(path, accept);
    // Side b owns its socket so `drop` can sever the link the way a crash
    // does, with no `close` frame and no FIN.
    const clientSocket = await rawConnect(path);
    const a = new Session(await accepted, aOptions);
    const b = new Session(ipcSocketPort(clientSocket, {}), bOptions);
    // A real socket needs an event loop turn to carry the two hellos; the suite
    // expects a pair that is already connected (or already refused).
    await Promise.allSettled([a.ready, b.ready]);
    return {
      a,
      b,
      drop: () => {
        clientSocket.destroy();
      },
      close: async () => {
        a.close();
        b.close();
        await server.close();
      },
    };
  },

  // Frames are split across `data` chunks on a byte stream, so two concurrent
  // oversized results are a reassembly test the suite already knows how to run.
  chunked: true,

  async connectRaw(aOptions: SessionOptions) {
    const path = nextPath();
    const { accepted, accept } = acceptOne();
    const server = await listenIpc(path, accept);
    const socket = await rawConnect(path, true);
    const a = new Session(await accepted, aOptions);
    return {
      a,
      write: (line: string) => {
        socket.write(line);
      },
      close: async () => {
        a.close();
        socket.destroy();
        await server.close();
      },
    };
  },
};

describe('local socket transport', () => {
  itBehavesLikeAMangoTransport(fixture);

  it('rejects a connection to a path with no listener', async () => {
    expect(await rejectionOf(connectIpc(nextPath()))).toMatchObject({ code: 'ENOENT' });
  });

  it('gives up on a connection nobody completes once the deadline passes', async () => {
    const path = nextPath();
    const connector = new StalledConnector();

    const rejection = await rejectionOf(
      connectIpc(path, { timeoutMs: 30, connect: connector.connect })
    );

    expect(rejection).toMatchObject({ name: 'TimeoutError' });
    expect((rejection as Error).message).toBe(
      `The connection to ${path} timed out after 30 ms; expected the peer to accept it.`
    );
    // A dial that gave up owns the descriptor it opened.
    expect(connector.only.destroyed).toBe(true);
  });

  it('abandons a connection when the signal aborts, and destroys the socket', async () => {
    const connector = new StalledConnector();
    const controller = new AbortController();
    const dial = connectIpc(nextPath(), {
      signal: controller.signal,
      connect: connector.connect,
    });

    controller.abort();

    expect(await rejectionOf(dial)).toMatchObject({ name: 'AbortError' });
    expect(connector.only.destroyed).toBe(true);
  });

  it('refuses a connection whose signal has already aborted, and dials nothing', async () => {
    const connector = new StalledConnector();

    const rejection = await rejectionOf(
      connectIpc(nextPath(), {
        signal: AbortSignal.abort(new Error('gone before we dialled')),
        connect: connector.connect,
      })
    );

    expect((rejection as Error).message).toBe('gone before we dialled');
    expect(connector.sockets).toHaveLength(0);
  });

  it('rejects when the connector refuses the address outright', async () => {
    const rejection = await rejectionOf(
      connectIpc(nextPath(), { timeoutMs: 30, connect: new RefusingConnector().connect })
    );

    expect(rejection).toMatchObject({ code: 'ENOTSOCK' });
  });

  it('keeps listening for errors on a socket it gave up on and destroyed', async () => {
    const connector = new StalledConnector();

    const rejection = await rejectionOf(
      connectIpc(nextPath(), { timeoutMs: 20, connect: connector.connect })
    );

    expect(rejection).toMatchObject({ name: 'TimeoutError' });
    // A destroyed socket that still reports — a pipe the peer reset — reaches
    // an `EventEmitter`, and an `error` with no listener there is rethrown as
    // an uncaught exception rather than ignored.
    expect(() => connector.only.emit('error', new Error('ECONNRESET'))).not.toThrow();
  });

  it('refuses a deadline that is not a positive number of milliseconds', async () => {
    expect(await rejectionOf(connectIpc(nextPath(), { timeoutMs: 0 }))).toMatchObject({
      message:
        'timeoutMs is 0; expected a positive finite number of milliseconds, or none for no deadline',
    });
  });

  it('clears the deadline of a connection that was made', async () => {
    const path = nextPath();
    const { accepted, accept } = acceptOne();
    const server = await listenIpc(path, accept);
    try {
      const client = await connectIpc(path, { timeoutMs: 30 });
      const host = await accepted;
      const frames: Frame[] = [];
      client.onFrame((frame) => frames.push(frame));

      // Well past the deadline: a timer left running would have destroyed the
      // socket under a connection that had already succeeded.
      await new Promise((resolve) => setTimeout(resolve, 60));
      host.send({ type: 'ping' });
      await tick();

      expect(frames).toEqual([{ type: 'ping' }]);
      client.close(CLOSE_CODES.RELEASED);
    } finally {
      await server.close();
    }
  });

  it('sends close 4000 to every open session before it stops listening', async () => {
    const path = nextPath();
    const { accepted, accept } = acceptOne();
    const server = await listenIpc(path, accept);
    const client = new Session(await connectIpc(path), {
      peer: CONFORMANCE_B,
      livenessIntervalMs: false,
    });
    const host = new Session(await accepted, { peer: CONFORMANCE_A, livenessIntervalMs: false });
    await Promise.all([client.ready, host.ready]);

    const closed = new Promise((resolve) => client.onClose(resolve));
    await server.close();

    expect(await closed).toMatchObject({
      code: CLOSE_CODES.RELEASED,
      reason: 'listener closing',
      fatal: false,
    });
  });

  it('reports a peer that vanished as a closure and fails what was in flight', async () => {
    const path = nextPath();
    const { accepted, accept } = acceptOne();
    const server = await listenIpc(path, accept);
    const socket = await rawConnect(path, true);
    const host = new Session(await accepted, {
      peer: CONFORMANCE_A,
      handlers: CONFORMANCE_HANDLERS,
      livenessIntervalMs: false,
    });
    socket.write(
      '{"type":"hello","protocol":{"major":1,"minor":0},"peer":{"name":"raw","version":"0","role":"tool"},"capabilities":{}}\n'
    );
    await host.ready;

    const pending = host.request('test.forever', {});
    await tick();
    socket.destroy();

    expect(await rejectionOf(pending)).toMatchObject({ code: RESERVED_ERROR_CODES.UNAVAILABLE });
    expect(host.state).toBe('closed');
    // No `close` frame crossed, so the closure is the plain 4000 release of §10.
    expect(host.closure?.code).toBe(CLOSE_CODES.RELEASED);
    await server.close();
  });

  it('releases a connection the peer never closes', async () => {
    const path = nextPath();
    const { accepted, accept } = acceptOne();
    const server = await listenIpc(path, accept);
    // A rude peer: `allowHalfOpen` keeps it from answering the listener's FIN,
    // so nothing but the listener itself can release the descriptor.
    const rude = await rawConnect(path, true, { allowHalfOpen: true });
    // Writing to a released socket is the assertion below; without a listener
    // the resulting `error` event would be an uncaught exception instead.
    rude.on('error', () => undefined);
    const hostPort = await accepted;

    hostPort.close(CLOSE_CODES.RELEASED, 'done');

    // `end` alone only half-closes: without the release the listener would keep
    // taking this peer's bytes, and hold the descriptor, until it shut down.
    expect(await writesRefusedWithin(rude, 1000)).toBe(true);
    rude.destroy();
    await server.close();
  });

  it('refuses one connection when the handler throws, and keeps listening', async () => {
    const path = nextPath();
    let accepted = 0;
    const server = await listenIpc(path, (port) => {
      accepted += 1;
      if (accepted === 1) throw new Error('handler blew up');
      port.close(CLOSE_CODES.RELEASED, 'served');
    });
    try {
      // A throw out of a `net` connection listener takes the process down; the
      // listener has to survive it and answer the next connection.
      await closedAfterConnect(path);
      await closedAfterConnect(path);
      expect(accepted).toBe(2);
    } finally {
      await server.close();
    }
  });

  // POSIX only: a named pipe has no filesystem entry to leave behind.
  it.skipIf(WINDOWS)('replaces the socket file a crashed listener left behind', async () => {
    const bound = nextPath();
    const stale = nextPath();
    const squatter = createServer();
    await new Promise<void>((resolve) => {
      squatter.listen(bound, () => resolve());
    });
    // Renaming before the close leaves the socket file behind exactly as a
    // process that died without unlinking would.
    await rename(bound, stale);
    await new Promise<void>((resolve) => {
      squatter.close(() => resolve());
    });
    expect(statSync(stale).isSocket()).toBe(true);

    const { accepted, accept } = acceptOne();
    const server = await listenIpc(stale, accept);
    try {
      const client = await connectIpc(stale);
      const port = await accepted;
      expect(port.maxFrameBytes).toBe(16 * 1024 * 1024);
      client.close(CLOSE_CODES.RELEASED);
    } finally {
      await server.close();
    }
  });

  // POSIX only: a named pipe has no address a second `listen` could steal —
  // Windows serialises pipe instances at the kernel level instead.
  it.skipIf(WINDOWS)('refuses to bind where a live listener answers', async () => {
    const path = nextPath();
    // Filters on a completed handshake rather than the first accepted
    // connection: the second `listenIpc` call below probes this address to
    // judge it live, and that probe connects and disconnects at once,
    // reaching this same `onConnection` before any real client does.
    let resolveHost: (session: Session) => void = () => undefined;
    const hostReady = new Promise<Session>((resolve) => {
      resolveHost = resolve;
    });
    const server = await listenIpc(path, (port) => {
      const session = new Session(port, {
        peer: CONFORMANCE_A,
        handlers: CONFORMANCE_HANDLERS,
        livenessIntervalMs: false,
      });
      session.ready.then(() => resolveHost(session)).catch(() => undefined);
    });

    try {
      const rejection = await rejectionOf(listenIpc(path, () => undefined));
      expect(rejection).toMatchObject({ code: 'EADDRINUSE' });

      const client = new Session(await connectIpc(path), {
        peer: CONFORMANCE_B,
        livenessIntervalMs: false,
      });
      const host = await hostReady;
      await Promise.all([client.ready, host.ready]);

      expect(await client.request('test.echo', { text: 'still here' })).toEqual({
        text: 'still here',
      });
      client.close(CLOSE_CODES.RELEASED);
    } finally {
      await server.close();
    }
  });

  // POSIX only: Windows guards a named pipe with an ACL, not a file mode.
  it.skipIf(WINDOWS)('creates the socket with owner-only permissions', async () => {
    const path = nextPath();
    const server = await listenIpc(path, () => undefined);
    try {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await server.close();
    }
  });
});

describe('ipcPath', () => {
  it('names a windows pipe or a socket file in the runtime directory', () => {
    const path = ipcPath('mango-hub');
    if (WINDOWS) expect(path).toBe('\\\\.\\pipe\\mango-hub');
    else expect(path.endsWith('/mango-hub.sock')).toBe(true);
  });

  // POSIX only: the runtime directory has no meaning for a named pipe.
  it.skipIf(WINDOWS)('prefers XDG_RUNTIME_DIR and falls back to the temp directory', () => {
    const original = process.env.XDG_RUNTIME_DIR;
    try {
      process.env.XDG_RUNTIME_DIR = '/run/user/4242';
      expect(ipcPath('mango-hub')).toBe('/run/user/4242/mango-hub.sock');
      delete process.env.XDG_RUNTIME_DIR;
      expect(ipcPath('mango-hub')).not.toBe('/run/user/4242/mango-hub.sock');
      expect(ipcPath('mango-hub').endsWith('/mango-hub.sock')).toBe(true);
    } finally {
      if (original === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = original;
    }
  });

  for (const name of ['', 'a/b', 'a\\b', '..', 'x..y', '../escape']) {
    it(`refuses the name ${JSON.stringify(name)}`, () => {
      expect(() => ipcPath(name)).toThrow(
        `ipc name is ${JSON.stringify(name)}; expected one non-empty path segment`
      );
    });
  }
});

/**
 * A socket that never connects and never fails, the way a dial to an address
 * whose listener accepts nothing behaves. A real listener cannot stand in for
 * one: the kernel completes the connection into the accept queue, so
 * `connectIpc` resolves before anybody accepts it.
 */
class StalledSocket extends EventEmitter {
  destroyed = false;

  destroy(): void {
    this.destroyed = true;
  }
}

/** A dialler that refuses the address before it opens anything, as `net.connect` does for a path that is not a socket. */
class RefusingConnector {
  readonly connect = (_path: string): Socket => {
    throw Object.assign(new Error('the address is not a socket'), { code: 'ENOTSOCK' });
  };
}

/** Hands out `StalledSocket`s and remembers them, in place of `net.connect`. */
class StalledConnector {
  readonly sockets: StalledSocket[] = [];

  readonly connect = (_path: string): Socket => {
    const socket = new StalledSocket();
    this.sockets.push(socket);
    return socket as unknown as Socket;
  };

  /** The one socket the dial opened. */
  get only(): StalledSocket {
    const socket = this.sockets[0];
    if (socket === undefined) throw new Error('the dial never opened a socket');
    return socket;
  }
}

/** True once the far end stopped accepting bytes, meaning it let the socket go. */
async function writesRefusedWithin(socket: Socket, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const refused = await new Promise<boolean>((resolve) => {
      socket.write('{"type":"ping"}\n', (error) => resolve(error !== undefined && error !== null));
    });
    if (refused) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/** Connects, waits for the listener to hang up, and reports nothing else. */
async function closedAfterConnect(path: string): Promise<void> {
  const socket = await rawConnect(path, true);
  await new Promise<void>((resolve) => socket.once('close', () => resolve()));
}

/** Lets the socket machinery deliver its queued events. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}
