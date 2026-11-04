import { expect, test } from 'bun:test';
import { mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { connect, createServer, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import outcomes from '../../../spec/fixtures/local-socket-probes.json';
import type { Port } from '../src/port';
import { Session } from '../src/session';
import { listenIpc, probe, probeError } from '../src/transports/ipc';

test.skipIf(process.platform === 'win32')(
  'late close cannot unlink a successor public address',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ipc-ownership-'));
    const path = join(dir, 's');
    const original = await listenIpc(path, () => undefined);
    const successor = createServer();
    try {
      await rename(path, join(dir, 'old'));
      await new Promise<void>((resolve, reject) => {
        successor.once('error', reject);
        successor.listen(path, resolve);
      });
      await original.close();
      expect((await stat(path)).isSocket()).toBe(true);
    } finally {
      await original.close();
      await new Promise<void>((resolve) => successor.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  }
);

test('probe observation fixture never calls an inconclusive result a listener', () => {
  for (const fixture of outcomes)
    expect(String(probeError(fixture.error).outcome)).toBe(fixture.outcome);
});

test('a probe timeout is inconclusive and destroys the bounded dial', async () => {
  const socket = new Socket();
  const result = await probe('fake probe', () => socket);
  expect(result).toEqual({ outcome: 'inconclusive', reason: 'timeout' });
  expect(socket.destroyed).toBe(true);
});

const unix = process.platform !== 'win32';

test.skipIf(!unix)(
  'accepted transport connections are bounded and dropped owners release capacity',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ipc-capacity-'));
    const ports: Port[] = [];
    const sockets: Socket[] = [];
    let acceptNext: (() => void) | undefined;
    const server = await listenIpc(join(dir, 's'), (port) => {
      ports.push(port);
      acceptNext?.();
    });
    try {
      for (let i = 0; i < 64; i++) {
        const accepted = new Promise<void>((resolve) => {
          acceptNext = resolve;
        });
        sockets.push(connect(server.path));
        await accepted;
      }
      const refused = connect(server.path);
      refused.on('error', () => undefined);
      await new Promise<void>((resolve) => refused.once('close', () => resolve()));
      expect(ports).toHaveLength(64);
      const released = sockets[0];
      const releasedPort = ports[0];
      const closed = new Promise<void>((resolve) => releasedPort?.onClosed(() => resolve()));
      released?.destroy();
      await closed;
      const accepted = new Promise<void>((resolve) => {
        acceptNext = resolve;
      });
      sockets.push(connect(server.path));
      await accepted;
      expect(ports).toHaveLength(65);
    } finally {
      for (const socket of sockets) socket.destroy();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
);

test.skipIf(!unix)('probe EOF creates no authenticated application work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ipc-probe-session-'));
  let calls = 0;
  let settled!: () => void;
  const closed = new Promise<void>((resolve) => {
    settled = resolve;
  });
  const server = await listenIpc(join(dir, 's'), (port) => {
    const session = new Session(port, {
      peer: { name: 'fixture', version: '0', role: 'hub' },
      livenessIntervalMs: false,
      handlers: {
        expensive: () => {
          calls++;
          return null;
        },
      },
    });
    session.ready.catch(() => undefined);
    session.onClose(() => settled());
  });
  try {
    await expect(listenIpc(server.path, () => undefined)).rejects.toMatchObject({
      probeOutcome: 'connected',
    });
    await closed;
    expect(calls).toBe(0);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test.skipIf(!unix)(
  'an idle accepted port without a Session is closed at its hello bound',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ipc-hello-bound-'));
    let accepted!: () => void;
    const reached = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const server = await listenIpc(join(dir, 's'), () => accepted());
    const socket = connect(server.path);
    socket.resume();
    socket.on('error', () => undefined);
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    try {
      await reached;
      await closed;
      expect(socket.destroyed).toBe(true);
    } finally {
      socket.destroy();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
  20_000
);
