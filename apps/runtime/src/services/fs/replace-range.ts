import { PathAccessError, RuntimeToolArgumentError } from '../../errors';
import type {
  RuntimeMutationResult,
  RuntimeReplaceRangeParams,
  RuntimeReplaceRangeResult,
} from '../../methods';
import { throwIfAborted } from '../cancellation';
import {
  assertLineNumbersCurrent,
  FileNotReadError,
  readFreshFile,
  recordFileEdit,
  withPathLocks,
} from '../file-freshness';
import {
  explainUnreadableMutationTarget,
  RegularFileWriteError,
  writeRegularFileAtomic,
} from '../fs-utils';
import { mutationSnapshot, snapshotFromBytes } from '../snapshot';
import { countTotalLines, looksBinary } from './read-file';

const NEWLINE = 0x0a;

export async function replaceRuntimeRange(
  params: RuntimeReplaceRangeParams,
  signal?: AbortSignal
): Promise<RuntimeMutationResult<RuntimeReplaceRangeResult>> {
  throwIfAborted(signal);

  return await withPathLocks([params.resolvedPath], async () => {
    let observed: Awaited<ReturnType<typeof readFreshFile>>;
    try {
      observed = await readFreshFile(params.chatId, params.resolvedPath);
    } catch (error) {
      if (error instanceof FileNotReadError) {
        throw await explainUnreadableMutationTarget(params.resolvedPath, 'edit', error);
      }
      throw error;
    }
    assertLineNumbersCurrent(params.chatId, params.resolvedPath, params.endLine);

    const sourceLines = splitLines(observed.bytes);
    validateRange(params, sourceLines.length);
    const replacementLines = splitLines(Buffer.from(params.content));
    const updatedLines = [
      ...sourceLines.slice(0, params.startLine - 1),
      ...replacementLines,
      ...sourceLines.slice(params.endLine),
    ];
    const updated = joinLines(
      updatedLines,
      observed.bytes[observed.bytes.byteLength - 1] === NEWLINE
    );
    assertStillText(updated, params.inputPath);
    // Everything above this line read; everything below it writes.
    throwIfAborted(signal);

    let committed: { mtimeMs: number };
    try {
      committed = await writeRegularFileAtomic(params.resolvedPath, updated);
    } catch (error) {
      if (error instanceof RegularFileWriteError) throw new PathAccessError(error.message);
      throw error;
    }

    const replacedLines = params.endLine - params.startLine + 1;
    const sha256 = recordFileEdit(
      params.chatId,
      params.resolvedPath,
      updated,
      committed.mtimeMs,
      replacementLines.length === replacedLines ? Number.MAX_SAFE_INTEGER : params.startLine - 1
    );
    return {
      result: {
        path: params.inputPath,
        replacedLines,
        newTotalLines: countTotalLines(updated),
        sha256,
      },
      mutations: mutationSnapshot(params.captureSnapshot, {
        path: params.resolvedPath,
        op: 'edit',
        before: snapshotFromBytes(observed.bytes),
        afterHash: sha256,
      }),
    };
  });
}

function assertStillText(updated: Uint8Array, inputPath: string): void {
  if (!looksBinary(updated)) return;
  throw new RuntimeToolArgumentError(
    `Refusing to edit "${inputPath}": content contains a NUL byte, which would make the file ` +
      'unreadable by read_file and leave it unrecoverable by the file tools.'
  );
}

function validateRange(params: RuntimeReplaceRangeParams, totalLines: number): void {
  if (
    !Number.isInteger(params.startLine) ||
    !Number.isInteger(params.endLine) ||
    params.startLine < 1 ||
    params.startLine > params.endLine ||
    params.endLine > totalLines
  ) {
    throw new RuntimeToolArgumentError(
      `Invalid line range ${params.startLine}-${params.endLine} for "${params.inputPath}" ` +
        `(${totalLines} lines). Expected 1 <= startLine <= endLine <= ${totalLines}.`
    );
  }
}

function splitLines(bytes: Uint8Array): Uint8Array[] {
  if (bytes.byteLength === 0) return [];
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let index = bytes.indexOf(NEWLINE); index !== -1; index = bytes.indexOf(NEWLINE, start)) {
    lines.push(bytes.subarray(start, index));
    start = index + 1;
  }
  if (start < bytes.byteLength) lines.push(bytes.subarray(start));
  return lines;
}

function joinLines(lines: readonly Uint8Array[], trailingNewline: boolean): Uint8Array {
  if (lines.length === 0) return new Uint8Array(0);
  const byteLength =
    lines.reduce((total, line) => total + line.byteLength, 0) +
    Math.max(lines.length - 1, 0) +
    (trailingNewline ? 1 : 0);
  const joined = new Uint8Array(byteLength);
  let offset = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    joined.set(line, offset);
    offset += line.byteLength;
    if (index < lines.length - 1 || trailingNewline) joined[offset++] = NEWLINE;
  }
  return joined;
}
