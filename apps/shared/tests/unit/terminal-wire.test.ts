import { describe, expect, it } from 'bun:test';
import Value from 'typebox/value';
import {
  chunkTerminalBytes,
  decodeTerminalClientMessage,
  decodeTerminalServerMessage,
  encodeTerminalClientMessage,
  encodeTerminalServerMessage,
  TERMINAL_CHUNK_MAX_BYTES,
  TERMINAL_CLIENT_FRAME,
  TERMINAL_CLIENT_MESSAGE_MAX_BYTES,
  TERMINAL_HUB_QUEUE_MAX_BYTES,
  TERMINAL_INFLIGHT_WINDOW_BYTES,
  TERMINAL_SERVER_FRAME,
  TERMINAL_SOCKET_SEND_HIGH_WATER_BYTES,
  TerminalOpenBodySchema,
  TerminalSessionSchema,
  TerminalWireError,
} from '../../src/terminal';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

describe('terminal wire codec', () => {
  it('round-trips every client message through one type byte', () => {
    const data = decodeTerminalClientMessage(
      encodeTerminalClientMessage({ type: 'data', data: bytes('ls -la\r') })
    );
    expect(data.type).toBe('data');
    if (data.type === 'data') expect(text(data.data)).toBe('ls -la\r');

    expect(
      decodeTerminalClientMessage(
        encodeTerminalClientMessage({ type: 'resize', cols: 132, rows: 40 })
      )
    ).toEqual({ type: 'resize', cols: 132, rows: 40 });
    expect(
      decodeTerminalClientMessage(encodeTerminalClientMessage({ type: 'ack', bytes: 70_000 }))
    ).toEqual({ type: 'ack', bytes: 70_000 });
    expect(decodeTerminalClientMessage(encodeTerminalClientMessage({ type: 'ping' }))).toEqual({
      type: 'ping',
    });
  });

  it('round-trips every server message', () => {
    const data = decodeTerminalServerMessage(
      encodeTerminalServerMessage({ type: 'data', data: bytes('hi\r\n') })
    );
    expect(data.type).toBe('data');
    if (data.type === 'data') expect(text(data.data)).toBe('hi\r\n');

    expect(
      decodeTerminalServerMessage(
        encodeTerminalServerMessage({ type: 'exit', exit: { exitCode: 0, signal: null } })
      )
    ).toEqual({ type: 'exit', exit: { exitCode: 0, signal: null } });
    expect(
      decodeTerminalServerMessage(
        encodeTerminalServerMessage({ type: 'notice', notice: { kind: 'dropped', bytes: 4096 } })
      )
    ).toEqual({ type: 'notice', notice: { kind: 'dropped', bytes: 4096 } });
    expect(decodeTerminalServerMessage(encodeTerminalServerMessage({ type: 'pong' }))).toEqual({
      type: 'pong',
    });
  });

  it('puts the type in the first byte so a data byte costs one byte', () => {
    const frame = encodeTerminalClientMessage({ type: 'data', data: bytes('x') });
    expect(frame.byteLength).toBe(2);
    expect(frame[0]).toBe(TERMINAL_CLIENT_FRAME.DATA);
    expect(encodeTerminalServerMessage({ type: 'pong' })).toEqual(
      new Uint8Array([TERMINAL_SERVER_FRAME.PONG])
    );
  });

  it('encodes the ack as a big-endian u32', () => {
    const frame = encodeTerminalClientMessage({ type: 'ack', bytes: 0x01_02_03_04 });
    expect([...frame]).toEqual([TERMINAL_CLIENT_FRAME.ACK, 1, 2, 3, 4]);
  });

  it('refuses a client message above the socket payload limit', () => {
    const oversized = new Uint8Array(TERMINAL_CLIENT_MESSAGE_MAX_BYTES + 1);
    expect(() => decodeTerminalClientMessage(oversized)).toThrow(TerminalWireError);
    expect(() => decodeTerminalClientMessage(oversized)).toThrow(
      `at most ${TERMINAL_CLIENT_MESSAGE_MAX_BYTES} bytes; received ${TERMINAL_CLIENT_MESSAGE_MAX_BYTES + 1}`
    );
  });

  it('refuses malformed frames with the expected shape in the message', () => {
    expect(() => decodeTerminalClientMessage(new Uint8Array(0))).toThrow('must carry a type byte');
    expect(() => decodeTerminalClientMessage(new Uint8Array([9]))).toThrow(
      'type must be 0..3; received 9'
    );
    expect(() => decodeTerminalServerMessage(new Uint8Array([7]))).toThrow(
      'type must be 0..3; received 7'
    );
    expect(() =>
      decodeTerminalClientMessage(new Uint8Array([TERMINAL_CLIENT_FRAME.ACK, 1, 2]))
    ).toThrow('ack body must be 4 bytes; received 2');
    expect(() =>
      decodeTerminalClientMessage(
        new Uint8Array([TERMINAL_CLIENT_FRAME.RESIZE, ...bytes('{"cols":0,"rows":1}')])
      )
    ).toThrow('resize body does not match its schema');
    expect(() =>
      decodeTerminalClientMessage(new Uint8Array([TERMINAL_CLIENT_FRAME.RESIZE, ...bytes('{')]))
    ).toThrow('resize body must be JSON');
    expect(() => encodeTerminalClientMessage({ type: 'ack', bytes: -1 })).toThrow(
      'between 0 and 4294967295; received -1'
    );
  });

  it('splits a paste into ordered pieces that each fit one message', () => {
    const paste = new Uint8Array(TERMINAL_CLIENT_MESSAGE_MAX_BYTES * 2 + 5).map((_, i) => i % 251);
    const chunks = chunkTerminalBytes(paste, TERMINAL_CLIENT_MESSAGE_MAX_BYTES - 1);
    expect(chunks.length).toBe(3);
    expect(chunks.every((chunk) => chunk.byteLength <= TERMINAL_CLIENT_MESSAGE_MAX_BYTES - 1)).toBe(
      true
    );
    const joined = new Uint8Array(paste.byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(joined).toEqual(paste);
    expect(chunkTerminalBytes(new Uint8Array(0), 8)).toEqual([]);
    expect(() => chunkTerminalBytes(paste, 0)).toThrow('positive integer; received 0');
  });
});

describe('terminal limits', () => {
  it('keeps every hop below the limit of the hop after it', () => {
    // A runtime chunk plus its type byte must fit one hub socket message, the
    // runtime's in-flight window must fit the hub's queue, and the hub's send
    // high-water mark must stay under the 64 KiB close-on-backpressure limit
    // every hub WebSocket route shares.
    expect(TERMINAL_CHUNK_MAX_BYTES + 1).toBeLessThanOrEqual(TERMINAL_CLIENT_MESSAGE_MAX_BYTES);
    expect(TERMINAL_INFLIGHT_WINDOW_BYTES).toBeLessThanOrEqual(TERMINAL_HUB_QUEUE_MAX_BYTES);
    expect(TERMINAL_SOCKET_SEND_HIGH_WATER_BYTES).toBeLessThan(64 * 1024);
  });
});

describe('terminal schemas', () => {
  it('accepts a running session and an exited one', () => {
    const running = {
      id: 'sess-1',
      environmentId: 'local',
      chatId: 'chat-1',
      title: 'bash',
      shell: 'bash',
      cwd: '/home/j/project',
      cols: 80,
      rows: 24,
      status: 'running',
      attached: true,
      createdAt: 1_700_000_000_000,
      lastActivityAt: 1_700_000_000_500,
    };
    expect(Value.Check(TerminalSessionSchema, running)).toBe(true);
    expect(
      Value.Check(TerminalSessionSchema, {
        ...running,
        chatId: null,
        status: 'exited',
        exit: { exitCode: 130, signal: null },
        attached: false,
      })
    ).toBe(true);
    expect(Value.Check(TerminalSessionSchema, { ...running, cols: 1 })).toBe(false);
  });

  it('lets an open request omit everything but the environment', () => {
    expect(Value.Check(TerminalOpenBodySchema, { environmentId: 'local' })).toBe(true);
    expect(Value.Check(TerminalOpenBodySchema, { environmentId: 'local', shell: 'fish' })).toBe(
      false
    );
    expect(Value.Check(TerminalOpenBodySchema, { environmentId: 'local', extra: 1 })).toBe(false);
  });
});
