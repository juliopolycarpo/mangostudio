import { describe, expect, it } from 'bun:test';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { CLOSE_CODES } from '../src/close';
import type { PortClosure } from '../src/port';
import { Session, type SessionOptions } from '../src/session';
import {
  CONFORMANCE_A,
  type ConformanceFixture,
  itBehavesLikeAMangoTransport,
} from '../src/testing/conformance';
import { rejectionOf } from '../src/testing/rejection';
import { spawnPort } from '../src/transports/spawn';
import { stdioPort } from '../src/transports/stdio';

/** A bare `bun` does not spawn on Windows; the resolved binary always does. */
const BUN = Bun.which('bun') ?? process.execPath;
const ECHO_CHILD = fileURLToPath(new URL('./fixtures/stdio-echo.ts', import.meta.url));

/**
 * Two stdio ports cross-wired through a pair of pipes: `a` writes what `b`
 * reads and the other way round, which is exactly the shape a parent and a
 * spawned child have.
 */
const fixture: ConformanceFixture = {
  async connect(aOptions: SessionOptions, bOptions: SessionOptions) {
    const aToB = new PassThrough();
    const bToA = new PassThrough();
    const a = new Session(stdioPort({ input: bToA, output: aToB }), aOptions);
    const b = new Session(stdioPort({ input: aToB, output: bToA }), bOptions);
    // A pipe needs an event loop turn to carry the two hellos; the suite
    // expects a pair that is already connected (or already refused).
    await Promise.allSettled([a.ready, b.ready]);
    return {
      a,
      b,
      // A crash: both pipes vanish without a `close` frame.
      drop: () => {
        aToB.destroy();
        bToA.destroy();
      },
      close: () => {
        a.close();
        b.close();
      },
    };
  },

  // Frames are split across `data` chunks on a byte stream, so two concurrent
  // oversized results are a reassembly test the suite already knows how to run.
  chunked: true,

  connectRaw(aOptions: SessionOptions) {
    const toA = new PassThrough();
    const fromA = new PassThrough();
    // Nobody reads the far side of a raw fixture; discard what the session writes.
    fromA.resume();
    const a = new Session(stdioPort({ input: toA, output: fromA }), aOptions);
    return Promise.resolve({
      a,
      write: (line: string) => {
        toA.write(line);
      },
      close: () => {
        a.close();
        toA.end();
      },
    });
  },
};

describe('stdio transport', () => {
  itBehavesLikeAMangoTransport(fixture);

  it('decodes a frame whose characters straddle a chunk boundary', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const port = stdioPort({ input, output });
    const received: unknown[] = [];
    port.onFrame((frame) => received.push(frame));

    const line = Buffer.from('{"type":"evt","topic":"t.x","seq":0,"payload":"🥭"}\n', 'utf8');
    input.write(line.subarray(0, 40));
    await tick();
    expect(received).toEqual([]);
    input.write(line.subarray(40));
    await tick();

    expect(received).toEqual([{ type: 'evt', topic: 't.x', seq: 0, payload: '🥭' }]);
  });

  it('writes frames and nothing else to the output', async () => {
    const output = new PassThrough();
    const written: string[] = [];
    output.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));
    const port = stdioPort({ input: new PassThrough(), output });

    port.send({ type: 'ping' });
    port.close(CLOSE_CODES.RELEASED, 'done');
    await tick();

    expect(written.join('')).toBe(
      '{"type":"ping"}\n{"type":"close","code":4000,"reason":"done"}\n'
    );
  });

  it('reports an EPIPE on the output as a closure instead of an uncaught error', async () => {
    const output = new PassThrough();
    const port = stdioPort({ input: new PassThrough(), output });
    const closures: PortClosure[] = [];
    port.onClosed((closure) => closures.push(closure));

    output.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    await tick();

    expect(closures).toEqual([{ kind: 'closed', reason: 'write EPIPE' }]);
  });

  it('refuses a send once the output is gone, naming the state', () => {
    const output = new PassThrough();
    const port = stdioPort({ input: new PassThrough(), output });
    const closures: PortClosure[] = [];
    port.onClosed((closure) => closures.push(closure));

    output.destroy();

    expect(() => port.send({ type: 'ping' })).toThrow(/state "failed".*not writable/);
    expect(closures).toEqual([{ kind: 'closed', reason: expect.stringContaining('not writable') }]);
  });

  it('serves a real child process over its own standard streams', async () => {
    // The child builds its port with `stdioPort()` and no arguments, which is
    // the only way to exercise the `process.stdin`/`process.stdout` defaults.
    const child = spawnPort({ argv: [BUN, ECHO_CHILD] });
    try {
      const session = new Session(child.port, { peer: CONFORMANCE_A, livenessIntervalMs: false });
      const remote = await session.ready;

      expect(remote.peer).toEqual({ name: 'stdio-echo', version: '0.1.0', role: 'tool' });
      expect(await session.request('test.echo', { line: 'over a real pipe · 🥭' })).toEqual({
        line: 'over a real pipe · 🥭',
      });
      expect(
        await rejectionOf(session.request('test.refuse', { code: 'NOPE', message: 'no' }))
      ).toMatchObject({ code: 'NOPE' });
    } finally {
      expect(await child.terminate()).toEqual({ code: 0, signal: null });
    }
  });

  it('releases the input when the port closes, so the process can exit', () => {
    const input = new PassThrough();
    const port = stdioPort({ input, output: new PassThrough() });
    expect(input.listenerCount('data')).toBe(1);

    port.close(CLOSE_CODES.RELEASED, 'done');

    // A flowing stream keeps the event loop alive: a peer whose session ended
    // has to be able to exit without anyone calling `process.exit`.
    expect(input.listenerCount('data')).toBe(0);
    expect(input.isPaused()).toBe(true);
  });

  it('reports end of input as a closure with no code', async () => {
    const input = new PassThrough();
    const port = stdioPort({ input, output: new PassThrough() });
    const closures: PortClosure[] = [];
    port.onClosed((closure) => closures.push(closure));

    input.end();
    await tick();

    expect(closures).toEqual([{ kind: 'closed' }]);
  });
});

/** Lets the stream machinery deliver its queued events. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}
