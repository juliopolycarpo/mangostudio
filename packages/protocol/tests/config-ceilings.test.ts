import { describe, expect, it } from 'bun:test';

import schema from '../../../spec/schema/1/protocol.json';
import { resolveFrameLimit } from '../src/codec/ndjson';
import type { Port } from '../src/port';
import type { Frame } from '../src/schemas/frames';
import { Session, type SessionOptions } from '../src/session';
import { createInProcessPortPair } from '../src/transports/in-process';

const MAX = schema.$defs.limits.properties.maxFrameBytes.maximum;
const MAX_IN_FLIGHT = schema.$defs.limits.properties.maxInFlight.maximum;
const peer = { name: 'test', version: '1', role: 'tool' };

/** Records construction-time side effects without a remote handshake. */
class RecordingPort implements Port {
  readonly sent: Frame[] = [];
  subscriptions = 0;
  receive?: (frame: Frame) => void;

  readonly maxFrameBytes?: number;

  constructor(ceiling?: number) {
    if (ceiling !== undefined) this.maxFrameBytes = ceiling;
  }

  send(frame: Frame): void {
    this.sent.push(frame);
  }

  onFrame(listener: (frame: Frame) => void): () => void {
    this.receive = listener;
    this.subscriptions += 1;
    return () => {};
  }

  onClosed(): () => void {
    this.subscriptions += 1;
    return () => {};
  }

  close(): void {}
}

function refuse(port: RecordingPort, options: Partial<SessionOptions>, name: string): void {
  expect(() => new Session(port, { peer, ...options })).toThrow(RangeError);
  expect(() => new Session(port, { peer, ...options })).toThrow(name);
  expect(port.sent).toEqual([]);
  expect(port.subscriptions).toBe(0);
}

describe('configuration ceilings', () => {
  it('accepts the schema maximum in codecs and transports without allocating it', () => {
    expect(resolveFrameLimit({ maxFrameBytes: MAX })).toBe(MAX);
    expect(createInProcessPortPair({ maxFrameBytes: MAX }).a.maxFrameBytes).toBe(MAX);
    expect(() => resolveFrameLimit({ maxFrameBytes: MAX + 1 })).toThrow(RangeError);
    expect(() => createInProcessPortPair({ maxFrameBytes: MAX + 1 })).toThrow(RangeError);
  });

  it.each<[number | undefined, number | undefined, number]>([
    [undefined, undefined, 16 * 1024 * 1024],
    [MAX, undefined, MAX],
    [undefined, MAX, MAX],
    [MAX, 4096, 4096],
    [4096, MAX, 4096],
    [MAX, MAX, MAX],
  ])('announces the effective minimum for session %p and port %p', (requested, port, effective) => {
    const recording = new RecordingPort(port);
    const session = new Session(recording, {
      peer,
      ...(requested === undefined ? {} : { maxFrameBytes: requested }),
      maxInFlight: MAX_IN_FLIGHT,
      maxStreamKeys: MAX_IN_FLIGHT + 1,
      livenessIntervalMs: false,
    });
    void session.ready.catch(() => {});
    expect(recording.sent[0]).toMatchObject({
      type: 'hello',
      limits: {
        ...(effective < 16 * 1024 * 1024 ? { maxFrameBytes: effective } : {}),
        maxInFlight: MAX_IN_FLIGHT,
      },
    });
    recording.receive?.({
      type: 'hello',
      peer,
      protocol: { major: 1, minor: 2 },
      capabilities: {},
      limits: { maxFrameBytes: MAX },
    });
    expect(session.sendLimitBytes).toBe(effective);
    session.closeNow();
  });

  it.each([undefined, 4096, MAX])(
    'refuses oversized inputs before hello with other ceiling %p',
    (other) => {
      refuse(new RecordingPort(other), { maxFrameBytes: MAX + 1 }, 'maxFrameBytes');
      refuse(
        new RecordingPort(MAX + 1),
        { ...(other === undefined ? {} : { maxFrameBytes: other }) },
        'port maxFrameBytes'
      );
      refuse(new RecordingPort(other), { maxInFlight: MAX_IN_FLIGHT + 1 }, 'maxInFlight');
    }
  );

  it.each(
    [null, NaN, Infinity, -Infinity, 4096.5, '4096', true, {}, [], Symbol('limit'), 4096n].map(
      (value) => [value]
    )
  )('refuses malformed or nonnumeric %p before hello', (value) => {
    const malformed = value as number;
    refuse(new RecordingPort(), { maxFrameBytes: malformed }, 'maxFrameBytes');
    refuse(new RecordingPort(malformed), {}, 'port maxFrameBytes');
    refuse(new RecordingPort(), { maxInFlight: malformed }, 'maxInFlight');
  });
});
