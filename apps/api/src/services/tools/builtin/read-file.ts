/**
 * Built-in tool: read_file
 * Reads the contents of a text file from disk with line numbers and windowing.
 */

import { getBoundedOptionalInteger } from '../arg-parsing';
import { recordFileRead } from '../file-freshness';
import { registerTool } from '../registry';
import type { ToolContext } from '../types';
import {
  BINARY_SNIFF_BYTES,
  containsNulByte,
  getRequiredPathArg,
  normalizePathList,
  PathAccessError,
  type PathValidationSettings,
  READ_FILE_MAX_BYTES,
  readFileWithObservedMtime,
  resolveAndValidatePath,
} from './_fs-utils';

const READ_FILE_TOOL_NAME = 'read_file';

const READ_FILE_DEFAULT_START_LINE = 1;
const READ_FILE_DEFAULT_MAX_LINES = 2000;
const READ_FILE_MIN_MAX_LINES = 1;
const READ_FILE_MAX_MAX_LINES = 5000;
/** Practical upper bound for startLine so extreme values clamp instead of allocating. */
const READ_FILE_MAX_START_LINE = 10_000_000;
export const READ_FILE_MAX_LINE_CHARS = 2000;
export const READ_FILE_MAX_WINDOW_BYTES = 256 * 1024;
const LINE_TRUNCATION_MARKER = '…[truncated]';
const WINDOW_TRUNCATION_NOTICE = '\n\n[truncated: use startLine/maxLines to read more]';
const NEWLINE = 0x0a;
const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const textDecoder = new TextDecoder();

export interface ReadFileToolArgs {
  path: string;
  startLine?: number;
  maxLines?: number;
}

export interface ReadFileToolResult {
  content: string;
  path: string;
  size: number;
  sha256: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
}

export type ReadFileToolSettings = PathValidationSettings;

const definition = {
  name: READ_FILE_TOOL_NAME,
  description:
    'Reads the contents of a text file from disk. Output is line-numbered (cat -n style); ' +
    'the line numbers are a reading aid and are not part of the file content. Use ' +
    'startLine/maxLines to window large files instead of reading everything at once. Use ' +
    'this when the user asks to inspect, view, or read a file.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path, ~ path, or path relative to the chat working directory.',
      },
      startLine: {
        type: 'integer',
        description: '1-based line to start reading from (default 1).',
        minimum: 1,
      },
      maxLines: {
        type: 'integer',
        description: `Maximum number of lines to return (default ${READ_FILE_DEFAULT_MAX_LINES}, max ${READ_FILE_MAX_MAX_LINES}).`,
        minimum: READ_FILE_MIN_MAX_LINES,
        maximum: READ_FILE_MAX_MAX_LINES,
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
};

export function normalizeReadFileToolSettings(
  parameters: Record<string, unknown>
): ReadFileToolSettings {
  return {
    allowedPaths: normalizePathList(parameters.allowedPaths),
    deniedPaths: normalizePathList(parameters.deniedPaths),
  };
}

export async function executeReadFile(
  args: ReadFileToolArgs,
  context: ToolContext
): Promise<ReadFileToolResult> {
  const settings = normalizeReadFileToolSettings(context.parameters);
  const resolvedPath = resolveAndValidatePath(args.path, {
    settings,
    workdir: context.workdir,
    workdirPolicy: context.workdirPolicy,
  });

  const startLine = args.startLine ?? READ_FILE_DEFAULT_START_LINE;
  const maxLines = args.maxLines ?? READ_FILE_DEFAULT_MAX_LINES;

  const { bytes, mtimeMs } = await readFileWithObservedMtime(resolvedPath, {
    maxBytes: READ_FILE_MAX_BYTES,
  });

  if (looksBinary(bytes)) {
    throw new PathAccessError(
      `"${args.path}" appears to be a binary file and cannot be read as text.`
    );
  }

  const size = bytes.byteLength;
  const totalLines = countTotalLines(bytes);

  // An empty file still answers line 1, so the floor of 1 keeps the default
  // read from failing on it while every other overshoot is rejected.
  if (startLine > Math.max(totalLines, 1)) {
    throw new PathAccessError(
      `startLine ${startLine} is past the end of "${args.path}" (${totalLines} lines).`
    );
  }

  if (totalLines === 0) {
    return {
      content: '',
      path: args.path,
      size,
      sha256: recordFileRead(context.chatId, resolvedPath, bytes, mtimeMs, {
        startLine: 1,
        endLine: 0,
        totalLines: 0,
      }),
      totalLines: 0,
      startLine: 1,
      endLine: 0,
      truncated: false,
    };
  }

  const requestedEndLine = Math.min(startLine + maxLines - 1, totalLines);
  const window = formatWindow(bytes, startLine, requestedEndLine, totalLines);

  return {
    content: window.content,
    path: args.path,
    size,
    // The digest covers the whole file so external edits are still detected,
    // but only the returned window counts as read for the write guard.
    sha256: recordFileRead(context.chatId, resolvedPath, bytes, mtimeMs, {
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

function execute(args: Record<string, unknown>, context: ToolContext): Promise<ReadFileToolResult> {
  const path = getRequiredPathArg(args.path, 'path');
  const startLine = getBoundedOptionalInteger(args.startLine, 'startLine', {
    min: 1,
    max: READ_FILE_MAX_START_LINE,
  });
  const maxLines = getBoundedOptionalInteger(args.maxLines, 'maxLines', {
    min: READ_FILE_MIN_MAX_LINES,
    max: READ_FILE_MAX_MAX_LINES,
  });
  return executeReadFile(
    {
      path,
      ...(startLine !== undefined ? { startLine } : {}),
      ...(maxLines !== undefined ? { maxLines } : {}),
    },
    context
  );
}

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool({
    definition,
    settings: {
      title: 'Read file',
      description: 'Allows the AI to read text files from disk.',
      category: 'system',
      enabledByDefault: true,
      canDisable: true,
      defaultParameters: {
        allowedPaths: [],
        deniedPaths: [],
      },
      parameterDescriptors: [
        {
          name: 'allowedPaths',
          label: 'Allowed paths',
          description: 'List of paths the tool is allowed to access. Leave empty to allow all.',
          type: 'path_list',
          required: false,
          defaultValue: [] as Array<{ path: string; enabled: boolean }>,
        },
        {
          name: 'deniedPaths',
          label: 'Denied paths',
          description: 'List of paths the tool is denied from accessing. Leave empty to deny none.',
          type: 'path_list',
          required: false,
          defaultValue: [] as Array<{ path: string; enabled: boolean }>,
        },
      ],
    },
    execute,
  });
}

/** NUL in the first 8 KiB means the file is not safe to treat as text. */
export function looksBinary(bytes: Uint8Array): boolean {
  return containsNulByte(bytes, BINARY_SNIFF_BYTES);
}

/**
 * Counts logical lines in raw bytes. Empty files are 0; a trailing newline does
 * not invent an extra blank line beyond the final terminator.
 */
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

/**
 * Decodes only the requested line window, numbers lines cat -n style, and
 * applies per-line and window byte caps.
 */
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
    // No line made it into the window: either the range covered nothing or the
    // byte budget could not fit even the first line.
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

/**
 * Cuts a string to `maxLength` UTF-16 code units without leaving a lone high
 * surrogate behind, which would make the tool result invalid UTF-8 downstream.
 */
function sliceWithoutSplittingSurrogatePair(text: string, maxLength: number): string {
  const lastCode = text.charCodeAt(maxLength - 1);
  const splitsPair = lastCode >= HIGH_SURROGATE_FIRST && lastCode <= HIGH_SURROGATE_LAST;
  return text.slice(0, splitsPair ? maxLength - 1 : maxLength);
}

/**
 * Locates the byte range covering lines [startLine, endLine] inclusive.
 * Newline (0x0A) offsets are UTF-8-safe because 0x0A never appears mid-sequence.
 */
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

  // An inverted range covers no lines. Without this the scan below never runs
  // and the fallthrough would hand back the whole rest of the file.
  if (endLine < startLine) return { start, end: start };

  let end = start;
  for (let line = startLine; line <= endLine; line++) {
    const next = bytes.indexOf(NEWLINE, end);
    if (next === -1) return { start, end: bytes.byteLength };
    end = next + 1;
  }

  return { start, end };
}
