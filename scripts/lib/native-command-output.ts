import { StringDecoder } from 'node:string_decoder';

export const MAX_MACHINE_STDOUT_LINE_BYTES = 16 * 2 ** 20;

/** Validates an explicit machine-output budget before spawning. Example: assertMachineStdoutLimit(8 * 2 ** 20). */
export function assertMachineStdoutLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_MACHINE_STDOUT_LINE_BYTES) {
    throw new Error(
      `machine stdout maxLineBytes: expected a positive safe integer <= ${MAX_MACHINE_STDOUT_LINE_BYTES} | received: ${limit}`
    );
  }
}

export interface MachineStdoutCapture {
  readonly write: (bytes: Buffer) => void;
  readonly end: () => void;
}

/**
 * Streams trusted machine stdout without retaining whole lines, while enforcing a UTF-8 byte limit.
 * LF separates lines and does not count toward their budget. A violation is reported once per line.
 * Example: const capture = createMachineStdoutCapture(8 * 2 ** 20, writeLog, reportError);
 */
export function createMachineStdoutCapture(
  maxLineBytes: number,
  output: (text: string) => void,
  reportError: (message: string) => void
): MachineStdoutCapture {
  assertMachineStdoutLimit(maxLineBytes);
  const decoder = new StringDecoder('utf8');
  let lineBytes = 0;
  let exceeded = false;
  const consume = (text: string): void => {
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf('\n', start);
      const end = newline === -1 ? text.length : newline;
      lineBytes += Buffer.byteLength(text.slice(start, end), 'utf8');
      if (lineBytes > maxLineBytes && !exceeded) {
        exceeded = true;
        reportError(
          `Machine stdout line: expected <= ${maxLineBytes} UTF-8 bytes | received: ${lineBytes}`
        );
      }
      if (newline === -1) break;
      lineBytes = 0;
      exceeded = false;
      start = newline + 1;
    }
    if (text) output(text);
  };
  return { write: (bytes) => consume(decoder.write(bytes)), end: () => consume(decoder.end()) };
}

/** The longest text line, in characters, {@link createTextLineTee} lets pass unreported. */
const TEXT_LINE_MAX_CHARS = 1_048_576;

export interface TextLineTee {
  /** Takes decoded text, in any split. */
  readonly write: (text: string) => void;
  /** Flushes the unterminated line, if any, with a newline of its own. */
  readonly end: () => void;
}

/**
 * Passes decoded text to `output` a complete line at a time, so two pipes writing one log never
 * interleave inside a line. A line over `maxLineChars` is reported once with its length, flushed
 * as it stands and ended with a newline. Only the new text is searched for a newline, so a line
 * that spans many reads costs one pass, not one per read.
 * Example: const tee = createTextLineTee(writeLog, reportError); tee.write('a\nb'); tee.end();
 */
export function createTextLineTee(
  output: (text: string) => void,
  reportError: (message: string) => void,
  maxLineChars: number = TEXT_LINE_MAX_CHARS
): TextLineTee {
  let pieces: string[] = [];
  let pendingLength = 0;
  const hold = (text: string): void => {
    if (text === '') return;
    pieces.push(text);
    pendingLength += text.length;
  };
  const take = (): string => {
    const text = pieces.join('');
    pieces = [];
    pendingLength = 0;
    return text;
  };
  return {
    write: (text) => {
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline === -1) {
        hold(text);
      } else {
        output(take() + text.slice(0, lastNewline + 1));
        hold(text.slice(lastNewline + 1));
      }
      if (pendingLength > maxLineChars) {
        reportError(
          `Output line of ${pendingLength} characters exceeds the ${maxLineChars}-character limit; expected bounded text reporter lines`
        );
        output(`${take()}\n`);
      }
    },
    end: () => {
      if (pendingLength > 0) output(`${take()}\n`);
    },
  };
}
