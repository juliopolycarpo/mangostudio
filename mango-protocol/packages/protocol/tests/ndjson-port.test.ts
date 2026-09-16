import { describe, expect, it } from 'bun:test';
import { CLOSE_CODES } from '../src/close';
import { CodecError } from '../src/errors';
import type { PortClosure } from '../src/port';
import { CLOSE_REASON_MAX_LENGTH } from '../src/schemas/common';
import type { Frame } from '../src/schemas/frames';
import { type ByteSink, createNdjsonPort } from '../src/transports/ndjson-port';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Collects everything a port writes, and can break the way a closed pipe does. */
class FakeByteSink implements ByteSink {
  readonly chunks: string[] = [];
  ended = false;
  failWith: Error | undefined;

  write(bytes: Uint8Array): void {
    if (this.failWith !== undefined) throw this.failWith;
    this.chunks.push(decoder.decode(bytes));
  }

  end(): void {
    this.ended = true;
  }

  /** Every complete line the port wrote, terminators removed. */
  get lines(): string[] {
    return this.chunks
      .join('')
      .split('\n')
      .filter((line) => line.length > 0);
  }
}

describe('NDJSON port', () => {
  it('round-trips frames through the sink and the decoder', () => {
    const sink = new FakeByteSink();
    const handle = createNdjsonPort({ sink });
    const received: Frame[] = [];
    handle.port.onFrame((frame) => received.push(frame));

    handle.port.send({ type: 'req', id: 'r-1', method: 'test.echo', params: { text: 'hé' } });
    expect(sink.chunks.join('')).toBe(
      '{"type":"req","id":"r-1","method":"test.echo","params":{"text":"hé"}}\n'
    );

    handle.feed(encoder.encode('{"type":"ping"}\n{"type":'));
    handle.feed(encoder.encode('"pong"}\n'));
    expect(received).toEqual([{ type: 'ping' }, { type: 'pong' }]);
  });

  it('keeps the close code when the reason will not fit the frame limit', () => {
    // The reason is capped by characters, but JSON escapes one NUL into six
    // bytes, so a schema-valid reason can still outgrow a lowered limit. The
    // code is what the peer needs: dropping the whole record for the sake of
    // its reason would leave a refused peer reading a plain release.
    const sink = new FakeByteSink();
    const handle = createNdjsonPort({ sink, maxFrameBytes: 4096 });

    handle.port.close(CLOSE_CODES.PROTOCOL_ERROR, '\0'.repeat(CLOSE_REASON_MAX_LENGTH));

    expect(sink.lines).toEqual(['{"type":"close","code":4400}']);
    expect(sink.ended).toBe(true);
  });

  it('exposes the frame limit it decodes under', () => {
    expect(createNdjsonPort({ sink: new FakeByteSink() }).port.maxFrameBytes).toBe(
      16 * 1024 * 1024
    );
    expect(
      createNdjsonPort({ sink: new FakeByteSink(), maxFrameBytes: 4096 }).port.maxFrameBytes
    ).toBe(4096);
  });

  it('refuses an oversized line with close 4400 and a protocol-error closure', () => {
    const sink = new FakeByteSink();
    const handle = createNdjsonPort({ sink, maxFrameBytes: 4096 });
    const closures: PortClosure[] = [];
    handle.port.onClosed((closure) => closures.push(closure));

    handle.feed(
      encoder.encode(`{"type":"req","id":"r","method":"a.b","params":"${'x'.repeat(5000)}`)
    );

    expect(closures).toHaveLength(1);
    const closure = closures[0];
    expect(closure?.kind).toBe('protocol-error');
    expect(closure?.code).toBe(CLOSE_CODES.PROTOCOL_ERROR);
    expect(closure?.kind === 'protocol-error' && closure.error).toBeInstanceOf(CodecError);
    expect(closure?.kind === 'protocol-error' && closure.error.kind).toBe('too-large');
    expect(sink.lines).toHaveLength(1);
    const written: unknown = JSON.parse(sink.lines[0] ?? 'null');
    expect(written).toMatchObject({ type: 'close', code: CLOSE_CODES.PROTOCOL_ERROR });
    expect(sink.ended).toBe(true);
  });

  it('refuses a hello nobody can read with close 4426', () => {
    const sink = new FakeByteSink();
    const handle = createNdjsonPort({ sink });
    const closures: PortClosure[] = [];
    handle.port.onClosed((closure) => closures.push(closure));

    handle.feed(encoder.encode('{"type":"hello","protocolVersion":"1.0.1"}\n'));

    expect(closures[0]?.code).toBe(CLOSE_CODES.PROTOCOL_MISMATCH);
    expect(JSON.parse(sink.lines[0] ?? 'null')).toMatchObject({
      type: 'close',
      code: CLOSE_CODES.PROTOCOL_MISMATCH,
    });
  });

  it('delivers nothing after a refusal', () => {
    const sink = new FakeByteSink();
    const handle = createNdjsonPort({ sink });
    const received: Frame[] = [];
    handle.port.onFrame((frame) => received.push(frame));

    handle.feed(encoder.encode('{"type":"ping"}\nnot json\n{"type":"pong"}\n'));
    handle.feed(encoder.encode('{"type":"ping"}\n'));

    expect(received).toEqual([{ type: 'ping' }]);
  });

  it('delivers a peer close frame as a frame and leaves close semantics to the session', () => {
    const sink = new FakeByteSink();
    const handle = createNdjsonPort({ sink });
    const received: Frame[] = [];
    const closures: PortClosure[] = [];
    handle.port.onFrame((frame) => received.push(frame));
    handle.port.onClosed((closure) => closures.push(closure));

    handle.feed(encoder.encode('{"type":"close","code":4409,"reason":"superseded"}\n'));

    expect(received).toEqual([{ type: 'close', code: 4409, reason: 'superseded' }]);
    expect(closures).toEqual([]);
    expect(sink.ended).toBe(false);
  });

  it('reports end of file once, and ignores a second one', () => {
    const sink = new FakeByteSink();
    const handle = createNdjsonPort({ sink });
    const closures: PortClosure[] = [];
    handle.port.onClosed((closure) => closures.push(closure));

    handle.eof();
    handle.eof();
    handle.failed(new Error('too late'));

    expect(closures).toEqual([{ kind: 'closed' }]);
    expect(sink.ended).toBe(true);
  });

  it('reports a broken sink as closed rather than crashing the caller', () => {
    const sink = new FakeByteSink();
    const handle = createNdjsonPort({ sink });
    const closures: PortClosure[] = [];
    handle.port.onClosed((closure) => closures.push(closure));
    sink.failWith = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

    expect(() => handle.port.send({ type: 'ping' })).toThrow(/state "failed" \(write EPIPE\)/);
    // The message is what tells a broken pipe apart from a peer that left.
    expect(closures).toEqual([{ kind: 'closed', reason: 'write EPIPE' }]);
  });

  it('writes a close frame, ends the sink, and never reports its own close', () => {
    const sink = new FakeByteSink();
    const handle = createNdjsonPort({ sink });
    const closures: PortClosure[] = [];
    handle.port.onClosed((closure) => closures.push(closure));

    handle.port.close(CLOSE_CODES.SUPERSEDED, 'superseded');
    handle.port.close(CLOSE_CODES.RELEASED);

    expect(sink.lines).toEqual(['{"type":"close","code":4409,"reason":"superseded"}']);
    expect(sink.ended).toBe(true);
    expect(closures).toEqual([]);
  });

  it('truncates a close reason to the length the wire accepts', () => {
    const sink = new FakeByteSink();
    const handle = createNdjsonPort({ sink });

    handle.port.close(CLOSE_CODES.INTERNAL, 'x'.repeat(2000));

    const frame = JSON.parse(sink.lines[0] ?? 'null') as { reason: string };
    expect(frame.reason).toHaveLength(1024);
    expect(sink.ended).toBe(true);
  });

  it('throws on send after close, naming the state it is in', () => {
    const handle = createNdjsonPort({ sink: new FakeByteSink() });
    handle.port.close(CLOSE_CODES.RELEASED, 'done');

    expect(() => handle.port.send({ type: 'ping' })).toThrow(
      /state "closed" \(closed by this side with 4000\); expected state "open"/
    );
  });

  it('throws on send after end of file, naming the state it is in', () => {
    const handle = createNdjsonPort({ sink: new FakeByteSink() });
    handle.eof();

    expect(() => handle.port.send({ type: 'ping' })).toThrow(/state "ended"/);
  });

  it('refuses to send a frame past its own limit', () => {
    const handle = createNdjsonPort({ sink: new FakeByteSink(), maxFrameBytes: 4096 });

    expect(() =>
      handle.port.send({ type: 'req', id: 'r', method: 'a.b', params: 'x'.repeat(5000) })
    ).toThrow(CodecError);
  });
});
