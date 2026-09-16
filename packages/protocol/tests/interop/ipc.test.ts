/**
 * A TypeScript session and a Rust session over one local socket, each side
 * taking a turn at listening.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { connect as connectSocket, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import legacyHello from '../../../../spec/fixtures/1/legacy-hello.json';
import { CLOSE_CODES } from '../../src/close';
import { LineDecoder } from '../../src/codec/ndjson';
import type { Port } from '../../src/port';
import { Session } from '../../src/session';
import { CONFORMANCE_A } from '../../src/testing/conformance';
import { connectIpc, type IpcServer, listenIpc } from '../../src/transports/ipc';
import {
  expectMangoPeerBehaviour,
  INTEROP_ENABLED,
  LEGACY_HELLO_CLOSE_CODE,
  type RunningPeer,
  startPeer,
} from './support';

const describeInterop = INTEROP_ENABLED ? describe : describe.skip;

let sequence = 0;

/** An address no other case in this run is using. */
function address(): string {
  const name = `mango-interop-${process.pid}-${++sequence}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

const running: RunningPeer[] = [];
const servers: IpcServer[] = [];

afterEach(async () => {
  for (const peer of running.splice(0)) peer.stop();
  for (const server of servers.splice(0)) await server.close();
});

describeInterop('interop: local socket (Rust serves, TypeScript dials)', () => {
  it('completes the handshake and serves every case', async () => {
    const peer = await startPeer(['--ipc', address()]);
    running.push(peer);

    const session = new Session(await connectIpc(peer.address, { timeoutMs: 30_000 }), {
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
  }, 60_000);

  it('answers a runtime-protocol 1.0.1 hello with 4426', async () => {
    const peer = await startPeer(['--ipc', address()]);
    running.push(peer);

    // A bare socket with no port over it: the bytes an old binary really puts
    // on the wire, written by hand.
    const socket = await rawConnect(peer.address);
    try {
      socket.write(`${legacyHello.cases[0]?.line ?? ''}\n`);
      expect((await readCloseFrame(socket)).code).toBe(LEGACY_HELLO_CLOSE_CODE);
    } finally {
      socket.destroy();
    }
  }, 60_000);
});

describeInterop('interop: local socket (TypeScript serves, Rust dials)', () => {
  it('completes the handshake and serves every case', async () => {
    const path = address();
    let accepted: ((port: Port) => void) | undefined;
    const connection = new Promise<Port>((resolve) => {
      accepted = resolve;
    });
    const server = await listenIpc(path, (port) => accepted?.(port));
    servers.push(server);

    const peer = await startPeer(['--connect', server.path]);
    running.push(peer);

    const session = new Session(await connection, {
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
    // The peer's own session ends with the socket, so it exits on its own.
    // Asserted after the block, not inside it: a throw in `finally` replaces
    // whatever failed above it, so a wedged peer would hide the real failure.
    expect(await peer.exited).toBe(0);
  }, 60_000);
});

function rawConnect(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket(path);
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.removeListener('error', reject);
      resolve(socket);
    });
  });
}

/** The first `close` frame the peer writes, decoded with this SDK's decoder. */
function readCloseFrame(socket: Socket): Promise<{ readonly code: number }> {
  return new Promise((resolve, reject) => {
    const decoder = new LineDecoder({});
    socket.on('data', (chunk: Buffer) => {
      const { frames } = decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length));
      for (const frame of frames) {
        if (frame.type === 'close') resolve(frame);
      }
    });
    socket.once('end', () => reject(new Error('the peer closed the socket without a close frame')));
    socket.once('error', reject);
  });
}
