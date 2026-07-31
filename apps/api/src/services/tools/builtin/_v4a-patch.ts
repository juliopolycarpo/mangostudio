/**
 * Pure parser for the V4A context-patch format used by apply_patch.
 *
 * Parsing deliberately performs no filesystem access. It preserves payload
 * line endings so callers can apply LF or CRLF patches without normalizing the
 * text the model supplied.
 */

const BEGIN_PATCH = '*** Begin Patch';
const END_PATCH = '*** End Patch';
const ADD_FILE = '*** Add File:';
const UPDATE_FILE = '*** Update File:';
const DELETE_FILE = '*** Delete File:';
const MOVE_TO = '*** Move to:';

type LineEnding = '' | '\n' | '\r\n';

interface RawPatchLine {
  readonly number: number;
  readonly text: string;
  readonly ending: LineEnding;
}

interface V4aAddOperation {
  readonly type: 'add';
  readonly path: string;
  readonly content: string;
  readonly lineNumber: number;
}

interface V4aDeleteOperation {
  readonly type: 'delete';
  readonly path: string;
  readonly lineNumber: number;
}

interface V4aHunkLine {
  readonly type: 'context' | 'add' | 'delete';
  readonly content: string;
  readonly ending: LineEnding;
  readonly lineNumber: number;
}

interface V4aUpdateHunk {
  readonly marker?: string;
  readonly lines: readonly V4aHunkLine[];
  readonly lineNumber: number;
}

interface V4aUpdateOperation {
  readonly type: 'update';
  readonly path: string;
  readonly moveTo?: string;
  readonly hunks: readonly V4aUpdateHunk[];
  readonly lineNumber: number;
}

export type V4aPatchOperation = V4aAddOperation | V4aDeleteOperation | V4aUpdateOperation;

export interface V4aPatch {
  readonly operations: readonly V4aPatchOperation[];
}

export class V4aPatchParseError extends Error {
  constructor(
    readonly lineNumber: number,
    message: string
  ) {
    super(`Invalid patch at line ${lineNumber}: ${message}`);
    this.name = 'V4aPatchParseError';
  }
}

/** Parses one complete `*** Begin Patch` / `*** End Patch` document. */
export function parseV4aPatch(patch: string): V4aPatch {
  const lines = splitPatchLines(patch);
  if (lines[0]?.text !== BEGIN_PATCH) {
    throw new V4aPatchParseError(1, `expected "${BEGIN_PATCH}".`);
  }

  const operations: V4aPatchOperation[] = [];
  let cursor = 1;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.text === END_PATCH) {
      if (cursor !== lines.length - 1) {
        throw new V4aPatchParseError(
          lines[cursor + 1].number,
          `unexpected content after "${END_PATCH}".`
        );
      }
      if (operations.length === 0) {
        throw new V4aPatchParseError(line.number, 'the patch contains no file operations.');
      }
      return { operations };
    }

    if (line.text.startsWith(ADD_FILE)) {
      const parsed = parseAddOperation(lines, cursor);
      operations.push(parsed.operation);
      cursor = parsed.next;
      continue;
    }
    if (line.text.startsWith(UPDATE_FILE)) {
      const parsed = parseUpdateOperation(lines, cursor);
      operations.push(parsed.operation);
      cursor = parsed.next;
      continue;
    }
    if (line.text.startsWith(DELETE_FILE)) {
      operations.push({
        type: 'delete',
        path: parseHeaderPath(line, DELETE_FILE),
        lineNumber: line.number,
      });
      cursor++;
      continue;
    }

    throw new V4aPatchParseError(line.number, `expected a file operation or "${END_PATCH}".`);
  }

  throw new V4aPatchParseError(lines.length + 1, `missing "${END_PATCH}".`);
}

function parseAddOperation(
  lines: readonly RawPatchLine[],
  headerIndex: number
): { operation: V4aAddOperation; next: number } {
  const header = lines[headerIndex];
  const content: string[] = [];
  let cursor = headerIndex + 1;
  while (cursor < lines.length && !isControlLine(lines[cursor].text)) {
    const line = lines[cursor];
    if (!line.text.startsWith('+')) {
      throw new V4aPatchParseError(
        line.number,
        'every added-file content line must start with "+".'
      );
    }
    content.push(line.text.slice(1), line.ending);
    cursor++;
  }
  return {
    operation: {
      type: 'add',
      path: parseHeaderPath(header, ADD_FILE),
      content: content.join(''),
      lineNumber: header.number,
    },
    next: cursor,
  };
}

function parseUpdateOperation(
  lines: readonly RawPatchLine[],
  headerIndex: number
): { operation: V4aUpdateOperation; next: number } {
  const header = lines[headerIndex];
  let cursor = headerIndex + 1;
  let moveTo: string | undefined;
  if (lines[cursor]?.text.startsWith(MOVE_TO)) {
    moveTo = parseHeaderPath(lines[cursor], MOVE_TO);
    cursor++;
  }

  const hunks: V4aUpdateHunk[] = [];
  let current: { marker?: string; lines: V4aHunkLine[]; lineNumber: number } | undefined;
  while (cursor < lines.length && !isControlLine(lines[cursor].text)) {
    const line = lines[cursor];
    if (line.text === '@@' || line.text.startsWith('@@ ')) {
      if (current) hunks.push(finishHunk(current));
      const marker = line.text === '@@' ? undefined : line.text.slice(3);
      if (marker !== undefined && marker.length === 0) {
        throw new V4aPatchParseError(line.number, 'an "@@" context marker must not be empty.');
      }
      current = { ...(marker ? { marker } : {}), lines: [], lineNumber: line.number };
      cursor++;
      continue;
    }
    if (line.text.startsWith('@@')) {
      throw new V4aPatchParseError(
        line.number,
        'hunk headers must be "@@" or "@@ <context marker>".'
      );
    }

    const prefix = line.text[0];
    const type =
      prefix === ' ' ? 'context' : prefix === '+' ? 'add' : prefix === '-' ? 'delete' : null;
    if (!type) {
      throw new V4aPatchParseError(
        line.number,
        'update lines must start with a space, "+", or "-".'
      );
    }
    current ??= { lines: [], lineNumber: line.number };
    current.lines.push({
      type,
      content: line.text.slice(1),
      ending: line.ending,
      lineNumber: line.number,
    });
    cursor++;
  }
  if (current) hunks.push(finishHunk(current));
  if (hunks.length === 0 && moveTo === undefined) {
    throw new V4aPatchParseError(
      header.number,
      'an update must contain at least one hunk or a move destination.'
    );
  }

  return {
    operation: {
      type: 'update',
      path: parseHeaderPath(header, UPDATE_FILE),
      ...(moveTo ? { moveTo } : {}),
      hunks,
      lineNumber: header.number,
    },
    next: cursor,
  };
}

function finishHunk(hunk: {
  marker?: string;
  lines: V4aHunkLine[];
  lineNumber: number;
}): V4aUpdateHunk {
  if (hunk.lines.length === 0) {
    throw new V4aPatchParseError(hunk.lineNumber, 'a hunk must contain patch lines.');
  }
  if (!hunk.lines.some((line) => line.type !== 'context')) {
    throw new V4aPatchParseError(hunk.lineNumber, 'a hunk must add or delete content.');
  }
  return hunk;
}

function parseHeaderPath(line: RawPatchLine, prefix: string): string {
  const path = line.text.slice(prefix.length).trim();
  if (!path) {
    throw new V4aPatchParseError(line.number, `"${prefix}" requires a path.`);
  }
  return path;
}

function isControlLine(line: string): boolean {
  return line.startsWith('*** ');
}

function splitPatchLines(input: string): RawPatchLine[] {
  if (input.length === 0) return [{ number: 1, text: '', ending: '' }];

  const lines: RawPatchLine[] = [];
  let start = 0;
  while (start < input.length) {
    const newline = input.indexOf('\n', start);
    if (newline === -1) {
      lines.push({ number: lines.length + 1, text: input.slice(start), ending: '' });
      break;
    }
    const isCrLf = newline > start && input[newline - 1] === '\r';
    lines.push({
      number: lines.length + 1,
      text: input.slice(start, isCrLf ? newline - 1 : newline),
      ending: isCrLf ? '\r\n' : '\n',
    });
    start = newline + 1;
  }
  return lines;
}
