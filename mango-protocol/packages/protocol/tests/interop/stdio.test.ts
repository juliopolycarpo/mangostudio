/**
 * TypeScript launcher, Rust child, stdio between them.
 *
 * Only one direction exists for this transport by nature: whoever spawns the
 * process is the launcher, and the child speaks on the pipes it was given.
 */

import { describe, expect, it } from 'bun:test';
import legacyHello from '../../../../spec/fixtures/1/legacy-hello.json';
import { CLOSE_CODES } from '../../src/close';
import { LineDecoder } from '../../src/codec/ndjson';
import type { Port } from '../../src/port';
import type { Frame } from '../../src/schemas/frames';
import { Session } from '../../src/session';
import { CONFORMANCE_A } from '../../src/testing/conformance';
import { rejectionOf } from '../../src/testing/rejection';
import { type ExitStatus, spawnPort } from '../../src/transports/spawn';
import { PROTOCOL_MINOR } from '../../src/version';
import {
  expectMangoPeerBehaviour,
  INTEROP_ENABLED,
  LEGACY_HELLO_CLOSE_CODE,
  peerBinary,
} from './support';

const describeInterop = INTEROP_ENABLED ? describe : describe.skip;

describeInterop('interop: stdio (TypeScript launches, Rust serves)', () => {
  it('completes the handshake and serves every case over the child pipes', async () => {
    const peer = spawnPort({ argv: [await peerBinary(), '--stdio'] });
    const session = new Session(peer.port, { peer: CONFORMANCE_A, livenessIntervalMs: false });
    let status: ExitStatus | undefined;
    try {
      await expectMangoPeerBehaviour(session);
    } finally {
      session.close(CLOSE_CODES.RELEASED, 'interop done');
      status = await peer.terminate();
    }
    // The child leaves on the end of its stdin; no signal was needed. Asserted
    // after the block, not inside it: a throw in `finally` replaces whatever
    // failed above it, and a child wedged enough to fail the cases above is
    // exactly the one `terminate` has to escalate a signal at.
    expect(status?.signal).toBeNull();
  }, 60_000);

  it('serves a session that pinned itself to the minor before this one', async () => {
    // The plain 1.0 half of the negotiation, against a peer built from this
    // branch: the wire minor moved, so a peer that never learned about it has
    // to keep working. Pinning this side is the closest a single-tree suite
    // gets to an older binary — the frames it puts on the wire are the ones a
    // 1.0 peer would.
    const peer = spawnPort({ argv: [await peerBinary(), '--stdio'] });
    const session = new Session(peer.port, {
      peer: CONFORMANCE_A,
      protocol: { major: 1, minor: 0 },
      livenessIntervalMs: false,
    });
    try {
      const remote = await session.ready;
      expect(remote.protocol.minor).toBe(PROTOCOL_MINOR);
      expect(remote.effectiveMinor).toBe(0);

      expect(await session.request('test.echo', { over: 'the wire' })).toEqual({
        over: 'the wire',
      });
      expect(await rejectionOf(session.request('rpc.discover', {}))).toMatchObject({
        code: 'INVALID_REQUEST',
        details: { effectiveMinor: 0 },
      });
    } finally {
      session.closeNow(CLOSE_CODES.RELEASED, 'interop done');
      await peer.terminate();
    }
  }, 60_000);

  it('refuses rpc.discover on the wire once it has negotiated minor 0', async () => {
    // The half the case above cannot reach: its session refuses the method
    // locally, so nothing is ever sent. Driving the port by hand puts the
    // request on the wire and proves the peer's own gate, which is the one
    // that matters to a 1.0 client written against another SDK.
    const peer = spawnPort({ argv: [await peerBinary(), '--stdio'] });
    const frames = collectFrames(peer.port);
    try {
      peer.port.send({
        type: 'hello',
        protocol: { major: 1, minor: 0 },
        peer: CONFORMANCE_A,
        capabilities: {},
      });
      await frames.next('hello');

      peer.port.send({ type: 'req', id: 'r-1', method: 'test.echo', params: { over: 'the wire' } });
      expect(await frames.next('res', 'err')).toMatchObject({
        type: 'res',
        id: 'r-1',
        result: { over: 'the wire' },
      });

      peer.port.send({ type: 'req', id: 'r-2', method: 'rpc.discover', params: {} });
      expect(await frames.next('res', 'err')).toMatchObject({
        type: 'err',
        id: 'r-2',
        error: { code: 'INVALID_REQUEST', details: { effectiveMinor: 0 } },
      });
    } finally {
      peer.port.close(CLOSE_CODES.RELEASED, 'interop done');
      await peer.terminate();
    }
  }, 60_000);

  it('answers a runtime-protocol 1.0.1 hello with 4426', async () => {
    // A raw child, with no port over its pipes: the bytes an old binary
    // really puts on the wire, written by hand.
    const child = Bun.spawn([await peerBinary(), '--stdio'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
    });
    try {
      child.stdin.write(`${legacyHello.cases[0]?.line ?? ''}\n`);
      await child.stdin.flush();

      const farewell = await readCloseFrame(child.stdout);
      expect(farewell.code).toBe(LEGACY_HELLO_CLOSE_CODE);
    } finally {
      child.kill();
      await child.exited;
    }
  }, 60_000);
});

/** The first `close` frame the child writes, decoded with this SDK's decoder. */
async function readCloseFrame(
  stream: ReadableStream<Uint8Array>
): Promise<{ readonly code: number }> {
  const decoder = new LineDecoder({});
  for await (const chunk of stream) {
    const { frames } = decoder.push(chunk);
    for (const frame of frames) {
      if (frame.type === 'close') return frame;
    }
  }
  throw new Error('the child ended its stdout without a close frame');
}

/**
 * Buffers everything a port delivers, and hands out the next frame of one of
 * the types asked for. Taking a set rather than one type is what lets a test
 * say "the reply, whichever it is" and then assert which it was: waiting for
 * `err` alone would turn a peer that answered `res` into a timeout instead of
 * a readable failure.
 */
function collectFrames(port: Port): { next(...types: Frame['type'][]): Promise<Frame> } {
  const pending: Frame[] = [];
  let wake: (() => void) | undefined;
  port.onFrame((frame) => {
    pending.push(frame);
    wake?.();
  });
  return {
    async next(...types) {
      for (;;) {
        const index = pending.findIndex((frame) => types.includes(frame.type));
        if (index !== -1) return pending.splice(index, 1)[0] as Frame;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}
