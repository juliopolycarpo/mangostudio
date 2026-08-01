import { describe, expect, it } from 'bun:test';
import {
  RUNTIME_CHUNK_HEADER_BYTES,
  RuntimeChunkReassembler,
  type RuntimeFrame,
} from '@mangostudio/shared/runtime-protocol';
import {
  clientWebSocketSink,
  createWebSocketFramePort,
  serverWebSocketSink,
  type WebSocketFramePortClosure,
  type WebSocketSendResult,
} from '../../../src';

const SMALL_CHUNK_BYTES = RUNTIME_CHUNK_HEADER_BYTES + 32;

function responseOf(size: number): RuntimeFrame {
  return { type: 'res', id: 'req-1', ok: { blob: 'x'.repeat(size) } };
}

/** A sink whose outcome each call can be scripted. */
function scriptedSink(outcomes: WebSocketSendResult[]) {
  const sent: Uint8Array[] = [];
  return {
    sent,
    sink: {
      send(message: Uint8Array): WebSocketSendResult {
        const outcome = outcomes.shift() ?? 'sent';
        if (outcome !== 'dropped') sent.push(message);
        return outcome;
      },
    },
  };
}

describe('websocket frame port', () => {
  it('stops writing under backpressure and finishes the frame on drain', () => {
    const { sent, sink } = scriptedSink(['sent', 'backpressure']);
    const port = createWebSocketFramePort({ sink, maxMessageBytes: SMALL_CHUNK_BYTES });

    port.send(responseOf(200));
    const paused = sent.length;
    expect(paused).toBeGreaterThan(1);

    port.handleDrain();
    expect(sent.length).toBeGreaterThan(paused);
    expect(reassembleAll(sent)).toEqual(responseOf(200));
  });

  it('keeps two frames from interleaving across a backpressure pause', () => {
    const { sent, sink } = scriptedSink(['sent', 'backpressure']);
    const port = createWebSocketFramePort({ sink, maxMessageBytes: SMALL_CHUNK_BYTES });

    port.send(responseOf(200));
    port.send({ type: 'pong' });
    port.handleDrain();

    const reassembler = new RuntimeChunkReassembler();
    const frames = sent
      .map((chunk) => reassembler.push(chunk))
      .filter((frame): frame is RuntimeFrame => frame !== null);
    expect(frames).toEqual([responseOf(200), { type: 'pong' }]);
  });

  it('ends the connection when a chunk is dropped', () => {
    const closures: WebSocketFramePortClosure[] = [];
    const { sink } = scriptedSink(['sent', 'dropped']);
    const port = createWebSocketFramePort({
      sink,
      maxMessageBytes: SMALL_CHUNK_BYTES,
      onClosed: (closure) => closures.push(closure),
    });

    port.send(responseOf(200));

    // Half a frame arrived and the rest never will; a chunk stream has no
    // resynchronisation point, so the connection is over.
    expect(closures).toHaveLength(1);
    expect(closures[0]?.kind).toBe('protocol-error');
    expect(() => port.send({ type: 'pong' })).toThrow();
  });

  it('refuses a text message instead of guessing at its framing', () => {
    const closures: WebSocketFramePortClosure[] = [];
    const { sink } = scriptedSink([]);
    const port = createWebSocketFramePort({ sink, onClosed: (closure) => closures.push(closure) });

    port.receive('{"type":"ping"}');

    expect(closures[0]).toMatchObject({ kind: 'protocol-error' });
  });

  it('reports a socket that went away, but not an owner-initiated close', () => {
    const closures: WebSocketFramePortClosure[] = [];
    const owned = createWebSocketFramePort({
      sink: scriptedSink([]).sink,
      onClosed: (closure) => closures.push(closure),
    });
    owned.close();
    expect(closures).toHaveLength(0);

    const lost = createWebSocketFramePort({
      sink: scriptedSink([]).sink,
      onClosed: (closure) => closures.push(closure),
    });
    lost.handleSocketClosed();
    expect(closures).toEqual([{ kind: 'closed' }]);
  });

  it('delivers a reassembled frame to its listeners', () => {
    const received: RuntimeFrame[] = [];
    const { sent, sink } = scriptedSink([]);
    const writer = createWebSocketFramePort({ sink, maxMessageBytes: SMALL_CHUNK_BYTES });
    const reader = createWebSocketFramePort({ sink: scriptedSink([]).sink });
    reader.onFrame((frame) => received.push(frame));

    writer.send(responseOf(500));
    for (const chunk of sent) reader.receive(chunk);

    expect(received).toEqual([responseOf(500)]);
  });
});

describe('websocket sinks', () => {
  it('maps a server socket result onto the three outcomes', () => {
    const outcomes = [64, -1, 0];
    const sink = serverWebSocketSink({ send: () => outcomes.shift() ?? 0 });

    expect(sink.send(new Uint8Array(1))).toBe('sent');
    expect(sink.send(new Uint8Array(1))).toBe('backpressure');
    expect(sink.send(new Uint8Array(1))).toBe('dropped');
  });

  it('reports a client socket write as sent, since the API says nothing else', () => {
    const written: Uint8Array[] = [];
    const sink = clientWebSocketSink({
      send: (message) => written.push(message),
      bufferedAmount: 0,
    });

    expect(sink.send(new Uint8Array([1, 2, 3]))).toBe('sent');
    expect(written).toHaveLength(1);
  });
});

function reassembleAll(chunks: readonly Uint8Array[]): RuntimeFrame | null {
  const reassembler = new RuntimeChunkReassembler();
  let frame: RuntimeFrame | null = null;
  for (const chunk of chunks) frame = reassembler.push(chunk) ?? frame;
  return frame;
}
