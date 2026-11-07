import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Session } from '../../src/session';
import { ipcSocketPort, listenIpc } from '../../src/transports/ipc';

const HELLO = Buffer.from(
  '{"type":"hello","protocol":{"major":1,"minor":0},"peer":{"name":"early-peer","version":"0","role":"tool"},"capabilities":{}}\n'
);

/** Real accepted socket with the complete peer hello already buffered before port construction. */
export async function prebufferedAcceptedHello(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'ipc-h-'));
  let accept!: (socket: Socket) => void;
  const accepted = new Promise<Socket>((resolve) => {
    accept = resolve;
  });
  const server = createServer((socket) => accept(socket));
  const path = join(directory, 's');
  let client: Socket | undefined;
  let socket: Socket | undefined;
  let host: Session | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    client = connect(path);
    client.on('error', () => undefined);
    client.resume();
    client.write(HELLO);
    socket = await accepted;
    const deadline = Date.now() + 1000;
    while (socket.readableLength < HELLO.byteLength) {
      assert(
        Date.now() < deadline,
        'the real accepted socket must buffer the peer hello before the test proceeds'
      );
      socket.read(0);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert(socket.readableLength >= HELLO.byteLength);
    const port = ipcSocketPort(socket, {});
    let helloObserved = 0;
    port.onFrame((frame) => {
      if (frame.type === 'hello') helloObserved++;
    });
    host = new Session(port, {
      peer: { name: 'buffered-host', version: '0', role: 'hub' },
      handshakeTimeoutMs: 500,
      livenessIntervalMs: false,
    });
    await host.ready;
    assert.equal(
      helloObserved,
      1,
      'the post-construction tap and Session must both receive the buffered hello'
    );
    assert.equal(host.state, 'ready');
  } finally {
    await host?.close();
    client?.destroy();
    socket?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

/** Production listener with a client that queues hello before its own connect callback. */
export async function earliestListenerHello(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'ipc-e-'));
  let accept!: (session: Session) => void;
  const accepted = new Promise<Session>((resolve) => {
    accept = resolve;
  });
  let host: Session | undefined;
  const server = await listenIpc(join(directory, 's'), (port) => {
    host = new Session(port, {
      peer: { name: 'early-host', version: '0', role: 'hub' },
      handshakeTimeoutMs: 500,
      livenessIntervalMs: false,
    });
    host.ready.catch(() => undefined);
    accept(host);
  });
  const client = connect(server.path);
  client.on('error', () => undefined);
  client.resume();
  client.write(HELLO);
  try {
    await (
      await accepted
    ).ready;
    assert.equal(host?.state, 'ready');
  } finally {
    await host?.close();
    client.destroy();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}
