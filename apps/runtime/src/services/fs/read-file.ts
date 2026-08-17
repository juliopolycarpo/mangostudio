import { FileTooLargeError, PathAccessError } from '../../errors';
import type { RuntimeReadFileParams, RuntimeReadFileResult } from '../../methods';
import { throwIfAborted } from '../cancellation';
import { recordFileRead } from '../file-freshness';
import {
  BINARY_SNIFF_BYTES,
  containsNulByte,
  READ_FILE_MAX_BINARY_VIEW_BYTES,
  READ_FILE_MAX_BYTES,
  readFileWithObservedMtime,
} from '../fs-utils';

const READ_FILE_DEFAULT_START_LINE = 1;
const READ_FILE_DEFAULT_MAX_LINES = 2000;
export const READ_FILE_MIN_MAX_LINES = 1;
export const READ_FILE_MAX_MAX_LINES = 5000;
export const READ_FILE_MAX_START_LINE = 10_000_000;
export const READ_FILE_MAX_LINE_CHARS = 2000;
export const READ_FILE_MAX_WINDOW_BYTES = 256 * 1024;
const LINE_TRUNCATION_MARKER = '…[truncated]';
const WINDOW_TRUNCATION_NOTICE = '\n\n[truncated: use startLine/maxLines to read more]';
const NEWLINE = 0x0a;
/**
 * The line fields a result carries when there is no line structure to report:
 * an empty file, and a byte view, which holds bytes rather than lines.
 */
const NO_LINE_STRUCTURE = {
  totalLines: 0,
  startLine: 1,
  endLine: 0,
  truncated: false,
} as const;
const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const textDecoder = new TextDecoder();

export async function readRuntimeFile(
  params: RuntimeReadFileParams,
  signal?: AbortSignal
): Promise<RuntimeReadFileResult> {
  // One bounded read: entry is the only point where refusing saves anything.
  throwIfAborted(signal);
  const view = params.view ?? 'text';
  if (view !== 'text') return await readByteView(params, view);

  const startLine = params.startLine ?? READ_FILE_DEFAULT_START_LINE;
  const maxLines = params.maxLines ?? READ_FILE_DEFAULT_MAX_LINES;
  const { bytes, mtimeMs } = await readFileWithObservedMtime(params.resolvedPath, {
    maxBytes: READ_FILE_MAX_BYTES,
  });

  if (looksBinary(bytes)) {
    throw new PathAccessError(
      `"${params.inputPath}" appears to be a binary file and cannot be read as text. ` +
        `Read it with view "hex" or "base64" instead (up to ${READ_FILE_MAX_BINARY_VIEW_BYTES} bytes).`
    );
  }

  const size = bytes.byteLength;
  const totalLines = countTotalLines(bytes);
  if (startLine > Math.max(totalLines, 1)) {
    throw new PathAccessError(
      `startLine ${startLine} is past the end of "${params.inputPath}" (${totalLines} lines).`
    );
  }

  if (totalLines === 0) {
    return {
      content: '',
      path: params.inputPath,
      size,
      sha256: recordFileRead(params.chatId, params.resolvedPath, bytes, mtimeMs, {
        startLine: 1,
        endLine: 0,
        totalLines: 0,
      }),
      ...NO_LINE_STRUCTURE,
    };
  }

  const requestedEndLine = Math.min(startLine + maxLines - 1, totalLines);
  const window = formatWindow(bytes, startLine, requestedEndLine, totalLines);
  return {
    content: window.content,
    path: params.inputPath,
    size,
    sha256: recordFileRead(params.chatId, params.resolvedPath, bytes, mtimeMs, {
      startLine,
      endLine: window.endLine,
      totalLines,
    }),
    totalLines,
    startLine,
    endLine: window.endLine,
    truncated: window.truncated,
  };
}

/**
 * Reads a whole file and hands back its bytes transcoded, with no line
 * structure imposed on them.
 *
 * This is what makes the read-before-overwrite guard satisfiable for a binary
 * file: the ledger only records what a read observed, and a text read refuses
 * every file with a NUL byte in it. The bound is much tighter than the text
 * ceiling because the transcoded string is not windowed — all of it reaches the
 * model — so an oversized file is refused rather than truncated, which would
 * record a partial observation as a complete one.
 */
async function readByteView(
  params: RuntimeReadFileParams,
  view: Exclude<NonNullable<RuntimeReadFileParams['view']>, 'text'>
): Promise<RuntimeReadFileResult> {
  const { bytes, mtimeMs } = await readFileWithObservedMtime(params.resolvedPath, {
    maxBytes: READ_FILE_MAX_BINARY_VIEW_BYTES,
  }).catch((error: unknown) => {
    if (!(error instanceof FileTooLargeError)) throw error;
    // Rethrown as the same type so `details.limitBytes` still reaches the hub;
    // only the message improves, to name the bound the *view* carries rather
    // than the one a text read would have reported.
    throw new FileTooLargeError(
      `Cannot read "${params.inputPath}" as ${view}: a byte view is limited to ` +
        `${READ_FILE_MAX_BINARY_VIEW_BYTES} bytes because the whole result reaches the model, ` +
        'and it is not windowed. A text file can be read with view "text", which windows by line.',
      READ_FILE_MAX_BINARY_VIEW_BYTES
    );
  });

  return {
    // A view over the bytes, not a copy of them: `readFileWithObservedMtime`
    // already hands back a buffer this can transcode in place.
    content: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(view),
    path: params.inputPath,
    size: bytes.byteLength,
    // No observed range: the view holds every byte, so this is a complete
    // observation and write_file's guard accepts it.
    sha256: recordFileRead(params.chatId, params.resolvedPath, bytes, mtimeMs),
    ...NO_LINE_STRUCTURE,
    view,
  };
}

export function looksBinary(bytes: Uint8Array): boolean {
  return containsNulByte(bytes, BINARY_SNIFF_BYTES);
}

export function countTotalLines(bytes: Uint8Array): number {
  if (bytes.byteLength === 0) return 0;
  let lines = 0;
  for (
    let index = bytes.indexOf(NEWLINE);
    index !== -1;
    index = bytes.indexOf(NEWLINE, index + 1)
  ) {
    lines++;
  }
  if (bytes[bytes.byteLength - 1] !== NEWLINE) lines++;
  return lines;
}

interface FormattedWindow {
  readonly content: string;
  readonly endLine: number;
  readonly truncated: boolean;
}

function formatWindow(
  bytes: Uint8Array,
  startLine: number,
  requestedEndLine: number,
  totalLines: number
): FormattedWindow {
  const { start, end } = findWindowByteRange(bytes, startLine, requestedEndLine);
  let windowBytes = bytes.subarray(start, end);
  if (windowBytes.byteLength > 0 && windowBytes[windowBytes.byteLength - 1] === NEWLINE) {
    windowBytes = windowBytes.subarray(0, windowBytes.byteLength - 1);
  }

  const rawLines = start === end ? [] : textDecoder.decode(windowBytes).split('\n');
  const numbered: string[] = [];
  let byteBudget = 0;
  let truncated = false;
  let endLine = startLine - 1;

  for (let offset = 0; offset < rawLines.length; offset++) {
    const lineNumber = startLine + offset;
    let body = rawLines[offset] ?? '';
    if (body.length > READ_FILE_MAX_LINE_CHARS) {
      body = `${sliceWithoutSplittingSurrogatePair(body, READ_FILE_MAX_LINE_CHARS)}${LINE_TRUNCATION_MARKER}`;
      truncated = true;
    }

    const numberedLine = `${String(lineNumber).padStart(6, ' ')}\t${body}`;
    const lineBytes = Buffer.byteLength(numberedLine, 'utf8');
    const separatorBytes = numbered.length > 0 ? 1 : 0;
    if (byteBudget + separatorBytes + lineBytes > READ_FILE_MAX_WINDOW_BYTES) {
      truncated = true;
      break;
    }

    numbered.push(numberedLine);
    byteBudget += separatorBytes + lineBytes;
    endLine = lineNumber;
  }

  if (endLine < startLine) {
    return {
      content: WINDOW_TRUNCATION_NOTICE.trimStart(),
      endLine: startLine - 1,
      truncated: true,
    };
  }

  let content = numbered.join('\n');
  if (truncated || endLine < totalLines) {
    truncated = true;
    content += WINDOW_TRUNCATION_NOTICE;
  }
  return { content, endLine, truncated };
}

function sliceWithoutSplittingSurrogatePair(text: string, maxLength: number): string {
  const lastCode = text.charCodeAt(maxLength - 1);
  const splitsPair = lastCode >= HIGH_SURROGATE_FIRST && lastCode <= HIGH_SURROGATE_LAST;
  return text.slice(0, splitsPair ? maxLength - 1 : maxLength);
}

export function findWindowByteRange(
  bytes: Uint8Array,
  startLine: number,
  endLine: number
): { start: number; end: number } {
  let start = 0;
  for (let line = 1; line < startLine; line++) {
    const next = bytes.indexOf(NEWLINE, start);
    if (next === -1) return { start: bytes.byteLength, end: bytes.byteLength };
    start = next + 1;
  }
  if (endLine < startLine) return { start, end: start };

  let end = start;
  for (let line = startLine; line <= endLine; line++) {
    const next = bytes.indexOf(NEWLINE, end);
    if (next === -1) return { start, end: bytes.byteLength };
    end = next + 1;
  }
  return { start, end };
}
