/**
 * Binary framing for the browser↔hub terminal socket.
 *
 * Every message is one byte of type followed by its body. Data rides raw so
 * a byte of shell output costs one byte on the wire; the control messages are
 * small JSON documents or a fixed-width integer. Browser-safe on purpose:
 * `Uint8Array`, `DataView` and `TextEncoder` only, no `Buffer`.
 *
 * // Usage:
 * //   socket.send(encodeTerminalClientMessage({ type: 'ack', bytes: 8192 }));
 * //   const message = decodeTerminalServerMessage(new Uint8Array(event.data));
 */

import type { TSchema } from 'typebox';
import Value from 'typebox/value';
import {
  TERMINAL_CLIENT_MESSAGE_MAX_BYTES,
  type TerminalExit,
  TerminalExitSchema,
  type TerminalNotice,
  TerminalNoticeSchema,
  type TerminalSize,
  TerminalSizeSchema,
} from './schemas';

/** Type byte of each browser→hub message. */
export const TERMINAL_CLIENT_FRAME = {
  DATA: 0,
  RESIZE: 1,
  ACK: 2,
  PING: 3,
} as const;

/** Type byte of each hub→browser message. */
export const TERMINAL_SERVER_FRAME = {
  DATA: 0,
  EXIT: 1,
  NOTICE: 2,
  PONG: 3,
} as const;

export type TerminalClientMessage =
  | { readonly type: 'data'; readonly data: Uint8Array }
  | { readonly type: 'resize'; readonly cols: number; readonly rows: number }
  | { readonly type: 'ack'; readonly bytes: number }
  | { readonly type: 'ping' };

export type TerminalServerMessage =
  | { readonly type: 'data'; readonly data: Uint8Array }
  | { readonly type: 'exit'; readonly exit: TerminalExit }
  | { readonly type: 'notice'; readonly notice: TerminalNotice }
  | { readonly type: 'pong' };

/** A frame that does not follow this framing. The message names what was expected. */
export class TerminalWireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalWireError';
  }
}

const ACK_BODY_BYTES = 4;
const MAX_ACK_BYTES = 0xff_ff_ff_ff;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encodes one browser→hub message. */
export function encodeTerminalClientMessage(message: TerminalClientMessage): Uint8Array {
  switch (message.type) {
    case 'data':
      return withTypeByte(TERMINAL_CLIENT_FRAME.DATA, message.data);
    case 'resize':
      return withTypeByte(
        TERMINAL_CLIENT_FRAME.RESIZE,
        encoder.encode(JSON.stringify({ cols: message.cols, rows: message.rows }))
      );
    case 'ack': {
      if (!Number.isInteger(message.bytes) || message.bytes < 0 || message.bytes > MAX_ACK_BYTES) {
        throw new TerminalWireError(
          `Terminal ack must be an integer between 0 and ${MAX_ACK_BYTES}; received ${message.bytes}.`
        );
      }
      const body = new Uint8Array(ACK_BODY_BYTES);
      new DataView(body.buffer).setUint32(0, message.bytes, false);
      return withTypeByte(TERMINAL_CLIENT_FRAME.ACK, body);
    }
    case 'ping':
      return withTypeByte(TERMINAL_CLIENT_FRAME.PING, new Uint8Array(0));
  }
}

/** Decodes one browser→hub message; refuses oversized or malformed frames. */
export function decodeTerminalClientMessage(bytes: Uint8Array): TerminalClientMessage {
  if (bytes.byteLength > TERMINAL_CLIENT_MESSAGE_MAX_BYTES) {
    throw new TerminalWireError(
      `Terminal client message must be at most ${TERMINAL_CLIENT_MESSAGE_MAX_BYTES} bytes; received ${bytes.byteLength}.`
    );
  }
  const type = typeByteOf(bytes, 'client');
  const body = bytes.subarray(1);
  switch (type) {
    case TERMINAL_CLIENT_FRAME.DATA:
      return { type: 'data', data: body };
    case TERMINAL_CLIENT_FRAME.RESIZE: {
      const size = parseJsonBody<TerminalSize>(body, TerminalSizeSchema, 'resize');
      return { type: 'resize', cols: size.cols, rows: size.rows };
    }
    case TERMINAL_CLIENT_FRAME.ACK: {
      if (body.byteLength !== ACK_BODY_BYTES) {
        throw new TerminalWireError(
          `Terminal ack body must be ${ACK_BODY_BYTES} bytes; received ${body.byteLength}.`
        );
      }
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
      return { type: 'ack', bytes: view.getUint32(0, false) };
    }
    case TERMINAL_CLIENT_FRAME.PING:
      return { type: 'ping' };
    default:
      throw new TerminalWireError(
        `Terminal client frame type must be 0..3; received ${String(type)}.`
      );
  }
}

/** Encodes one hub→browser message. */
export function encodeTerminalServerMessage(message: TerminalServerMessage): Uint8Array {
  switch (message.type) {
    case 'data':
      return withTypeByte(TERMINAL_SERVER_FRAME.DATA, message.data);
    case 'exit':
      return withTypeByte(TERMINAL_SERVER_FRAME.EXIT, encoder.encode(JSON.stringify(message.exit)));
    case 'notice':
      return withTypeByte(
        TERMINAL_SERVER_FRAME.NOTICE,
        encoder.encode(JSON.stringify(message.notice))
      );
    case 'pong':
      return withTypeByte(TERMINAL_SERVER_FRAME.PONG, new Uint8Array(0));
  }
}

/** Decodes one hub→browser message. */
export function decodeTerminalServerMessage(bytes: Uint8Array): TerminalServerMessage {
  const type = typeByteOf(bytes, 'server');
  const body = bytes.subarray(1);
  switch (type) {
    case TERMINAL_SERVER_FRAME.DATA:
      return { type: 'data', data: body };
    case TERMINAL_SERVER_FRAME.EXIT:
      return { type: 'exit', exit: parseJsonBody<TerminalExit>(body, TerminalExitSchema, 'exit') };
    case TERMINAL_SERVER_FRAME.NOTICE:
      return {
        type: 'notice',
        notice: parseJsonBody<TerminalNotice>(body, TerminalNoticeSchema, 'notice'),
      };
    case TERMINAL_SERVER_FRAME.PONG:
      return { type: 'pong' };
    default:
      throw new TerminalWireError(
        `Terminal server frame type must be 0..3; received ${String(type)}.`
      );
  }
}

/**
 * Splits a byte run into pieces no larger than `maxBytes`, in order. An empty
 * input yields nothing; a paste larger than one socket message becomes several.
 *
 * // Usage: chunkTerminalBytes(pasted, TERMINAL_CLIENT_MESSAGE_MAX_BYTES - 1)
 */
export function chunkTerminalBytes(bytes: Uint8Array, maxBytes: number): Uint8Array[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new TerminalWireError(
      `Terminal chunk size must be a positive integer; received ${maxBytes}.`
    );
  }
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += maxBytes) {
    chunks.push(bytes.subarray(offset, Math.min(offset + maxBytes, bytes.byteLength)));
  }
  return chunks;
}

function withTypeByte(type: number, body: Uint8Array): Uint8Array {
  const frame = new Uint8Array(1 + body.byteLength);
  frame[0] = type;
  frame.set(body, 1);
  return frame;
}

function typeByteOf(bytes: Uint8Array, side: 'client' | 'server'): number {
  if (bytes.byteLength === 0) {
    throw new TerminalWireError(
      `Terminal ${side} message must carry a type byte; received 0 bytes.`
    );
  }
  return bytes[0] as number;
}

function parseJsonBody<T>(body: Uint8Array, schema: TSchema, name: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(body));
  } catch {
    throw new TerminalWireError(
      `Terminal ${name} body must be JSON; received ${body.byteLength} undecodable bytes.`
    );
  }
  if (!Value.Check(schema, parsed)) {
    throw new TerminalWireError(
      `Terminal ${name} body does not match its schema; received ${JSON.stringify(parsed)}.`
    );
  }
  return parsed as T;
}
