import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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

test.skipIf(process.platform === 'win32')(
  'refuses an occupied non-socket before staging',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ipc-occupied-'));
    try {
      const path = join(dir, 's');
      await writeFile(path, 'keep');
      await expect(listenIpc(path, () => undefined)).rejects.toMatchObject({
        code: 'EADDRINUSE',
        path,
      });
      expect(await readFile(path, 'utf8')).toBe('keep');
      expect(await readdir(dir)).toEqual(['s']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
);

test.skipIf(process.platform === 'win32')(
  'competing publishers preserve the winning socket',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ipc-compete-'));
    const path = join(dir, 's');
    const results = await Promise.allSettled([
      listenIpc(path, () => undefined),
      listenIpc(path, () => undefined),
    ]);
    try {
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const loser = results.find((result) => result.status === 'rejected');
      expect(loser?.reason).toMatchObject({ code: 'EADDRINUSE', path });
      expect((await stat(path)).isSocket()).toBe(true);
    } finally {
      await Promise.all(
        results.map((result) => result.status === 'fulfilled' && result.value.close())
      );
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

test.skipIf(!unix)(
  'listener hello timeout settles the owning Session before its longer handshake timeout',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ipc-owner-timeout-'));
    let host: Session | undefined;
    let readyResult: Promise<string> | undefined;
    let closedCount = 0;
    const server = await listenIpc(join(dir, 's'), (port) => {
      host = new Session(port, {
        peer: { name: 'timeout-fixture', version: '0', role: 'hub' },
        handshakeTimeoutMs: 60_000,
        livenessIntervalMs: false,
      });
      readyResult = host.ready.then(
        () => 'resolved',
        () => 'rejected'
      );
      host.onClose(() => {
        closedCount++;
      });
    });
    const socket = connect(server.path);
    socket.resume();
    socket.on('error', () => undefined);
    const socketClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    try {
      await socketClosed;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        readyResult,
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('still pending after transport closed'), 250);
        }),
      ]);
      if (timer) clearTimeout(timer);
      expect(result).toBe('rejected');
      expect(host?.state).toBe('closed');
      expect(closedCount).toBe(1);
    } finally {
      socket.destroy();
      await host?.close();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
  20_000
);

test.skipIf(!unix)(
  'private staging supports a public pathname at the native Unix boundary',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ipc-path-bound-'));
    const limit = process.platform === 'linux' ? 107 : 103;
    const parent = join(dir, 'x'.repeat(limit - Buffer.byteLength(dir) - 3));
    const path = join(parent, 's');
    await mkdir(parent);
    const raw = createServer();
    let server: Awaited<ReturnType<typeof listenIpc>> | undefined;
    try {
      // Establish that this exact public pathname is accepted by the native listener.
      await new Promise<void>((resolve, reject) => {
        raw.once('error', reject);
        raw.listen(path, resolve);
      });
      await new Promise<void>((resolve) => raw.close(() => resolve()));
      server = await listenIpc(path, () => undefined);
      expect((await stat(path)).isSocket()).toBe(true);
    } finally {
      await new Promise<void>((resolve) => raw.close(() => resolve()));
      await server?.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
);

test.skipIf(!unix || Bun.which('node') === null)(
  'native Node preserves the valid Unix pathname boundary',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ipc-node-fixture-'));
    try {
      const result = await Bun.build({
        entrypoints: [new URL('./fixtures/ipc-boundary-node.ts', import.meta.url).pathname],
        target: 'node',
        format: 'esm',
        outdir: directory,
        naming: 'fixture.mjs',
      });
      expect(result.success).toBe(true);
      const child = Bun.spawn([Bun.which('node') ?? 'node', join(directory, 'fixture.mjs')], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
      expect(stdout).toContain('passed: native Node Unix boundary public path');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test.skipIf(!unix)(
  'public pathname bounds count UTF-8 bytes before any endpoint is published',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ipc-public-bytes-'));
    const maximum = process.platform === 'linux' ? 107 : 103;
    const path = join(
      directory,
      'é'.repeat(Math.floor((maximum - Buffer.byteLength(directory) - 1) / 2) + 1)
    );
    expect(path.length).toBeLessThanOrEqual(maximum);
    expect(Buffer.byteLength(path)).toBeGreaterThan(maximum);
    try {
      await expect(listenIpc(path, () => undefined)).rejects.toMatchObject({
        code: 'ENAMETOOLONG',
      });
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);
