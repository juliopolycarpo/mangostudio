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
