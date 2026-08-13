import Value from 'typebox/value';
import { type RuntimeFrame, RuntimeFrameSchema } from './schemas';

/** Upper bound for one NDJSON frame, measured as UTF-8 bytes without the newline. */
export const RUNTIME_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class RuntimeFrameCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeFrameCodecError';
  }
}

/** Validates a structured frame before a transport accepts it. */
export function assertRuntimeFrame(value: unknown): asserts value is RuntimeFrame {
  if (!Value.Check(RuntimeFrameSchema, value)) {
    throw new RuntimeFrameCodecError('Runtime frame does not match the protocol schema.');
  }
}

/** Encodes one validated frame as a complete NDJSON record. */
export function encodeRuntimeFrame(
  frame: RuntimeFrame,
  maxFrameBytes = RUNTIME_MAX_FRAME_BYTES
): string {
  assertRuntimeFrame(frame);
  let line: string;
  try {
    line = JSON.stringify(frame);
  } catch (error) {
    throw new RuntimeFrameCodecError(
      `Runtime frame is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  assertLineSize(line, maxFrameBytes);
  return `${line}\n`;
}

/** Decodes and validates one NDJSON record without its line terminator. */
export function decodeRuntimeFrameLine(
  line: string,
  maxFrameBytes = RUNTIME_MAX_FRAME_BYTES
): RuntimeFrame {
  if (line.length === 0) {
    throw new RuntimeFrameCodecError('Runtime frame must not be an empty line.');
  }
  assertLineSize(line, maxFrameBytes);

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new RuntimeFrameCodecError(
      `Runtime frame is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  assertRuntimeFrame(value);
  return value;
}

/**
 * Incrementally decodes NDJSON bytes. Complete records are returned immediately;
 * a trailing partial record is retained until the next push or finish().
 */
export class RuntimeFrameDecoder {
  readonly #decoder = new TextDecoder();
  readonly #maxFrameBytes: number;
  #buffer = '';

  constructor(options: { readonly maxFrameBytes?: number } = {}) {
    this.#maxFrameBytes = options.maxFrameBytes ?? RUNTIME_MAX_FRAME_BYTES;
  }

  push(chunk: Uint8Array | string): RuntimeFrame[] {
    this.#buffer +=
      typeof chunk === 'string' ? chunk : this.#decoder.decode(chunk, { stream: true });
    const frames: RuntimeFrame[] = [];

    for (let newline = this.#buffer.indexOf('\n'); newline !== -1; ) {
      const line = stripCarriageReturn(this.#buffer.slice(0, newline));
      this.#buffer = this.#buffer.slice(newline + 1);
      frames.push(decodeRuntimeFrameLine(line, this.#maxFrameBytes));
      newline = this.#buffer.indexOf('\n');
    }

    assertPendingSize(this.#buffer, this.#maxFrameBytes);
    return frames;
  }

  finish(): RuntimeFrame[] {
    this.#buffer += this.#decoder.decode();
    if (this.#buffer.length === 0) return [];
    const line = stripCarriageReturn(this.#buffer);
    this.#buffer = '';
    return [decodeRuntimeFrameLine(line, this.#maxFrameBytes)];
  }
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function assertLineSize(line: string, maxFrameBytes: number): void {
  const size = new TextEncoder().encode(line).byteLength;
  if (size <= maxFrameBytes) return;
  throw new RuntimeFrameCodecError(
    `Runtime frame exceeds the ${maxFrameBytes}-byte line limit (${size} bytes).`
  );
}

/**
 * Bounds a record still arriving, without measuring it exactly. UTF-8 never
 * encodes a string in fewer bytes than its UTF-16 length, so this catches one
 * that has already blown the limit while costing nothing per chunk — where an
 * exact measurement would re-encode the whole pending buffer on every push,
 * turning one large frame split across many reads into quadratic work. The
 * exact check still runs the moment the record completes.
 */
function assertPendingSize(pending: string, maxFrameBytes: number): void {
  if (pending.length <= maxFrameBytes) return;
  throw new RuntimeFrameCodecError(
    `Runtime frame exceeds the ${maxFrameBytes}-byte line limit before its terminator.`
  );
}
