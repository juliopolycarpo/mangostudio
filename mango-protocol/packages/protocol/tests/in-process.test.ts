import { describe, expect, it } from 'bun:test';
import { CodecError } from '../src/errors';
import { Session, type SessionOptions } from '../src/session';
import { type ConformanceFixture, itBehavesLikeAMangoTransport } from '../src/testing/conformance';
import { createInProcessPortPair } from '../src/transports/in-process';

function fixture(validateFrames: boolean): ConformanceFixture {
  return {
    connect(aOptions: SessionOptions, bOptions: SessionOptions) {
      const ports = createInProcessPortPair({ validateFrames });
      const a = new Session(ports.a, aOptions);
      const b = new Session(ports.b, bOptions);
      return Promise.resolve({
        a,
        b,
        drop: () => ports.b.close(4000, 'dropped'),
        close: () => {
          a.close();
          b.close();
        },
      });
    },
  };
}

describe('in-process transport (validate mode)', () => {
  itBehavesLikeAMangoTransport(fixture(true));

  it('refuses a frame the byte codec cannot represent', () => {
    const { a } = createInProcessPortPair({ validateFrames: true });
    expect(() =>
      a.send({ type: 'req', id: 'r', method: 'a.b', params: { big: 10n } as never })
    ).toThrow(CodecError);
  });

  it('delivers frames in order on a later microtask', async () => {
    const { a, b } = createInProcessPortPair();
    const seen: string[] = [];
    b.onFrame((frame) => seen.push(frame.type));
    a.send({ type: 'ping' });
    a.send({ type: 'pong' });
    expect(seen).toEqual([]);
    await Promise.resolve();
    expect(seen).toEqual(['ping', 'pong']);
  });

  it('refuses a frame ceiling below the floor of the wire', () => {
    // The pair round-trips every frame through the byte codec, which enforces
    // the floor; the port itself must refuse the same value at construction
    // rather than announce a ceiling no decoder in the SDK would accept.
    expect(() => createInProcessPortPair({ maxFrameBytes: 512 })).toThrow(
      new RangeError('maxFrameBytes is 512; expected an integer of at least 4096')
    );
  });

  it('reports the close code to the peer and not to the closer', async () => {
    const { a, b } = createInProcessPortPair();
    const closures: unknown[] = [];
    a.onClosed((closure) => closures.push(['a', closure]));
    b.onClosed((closure) => closures.push(['b', closure]));
    a.close(4409, 'superseded');
    await Promise.resolve();
    expect(closures).toEqual([['b', { kind: 'closed', code: 4409, reason: 'superseded' }]]);
    expect(() => a.send({ type: 'ping' })).toThrow(/closed/);
  });
});

describe('in-process transport (clone mode)', () => {
  itBehavesLikeAMangoTransport(fixture(false));
});
