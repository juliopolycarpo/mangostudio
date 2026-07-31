import { PathAccessError, RuntimeToolArgumentError } from '../../errors';
import type {
  RuntimeEditFileParams,
  RuntimeEditFileResult,
  RuntimeMutationResult,
} from '../../methods';
import { FileNotReadError, readFreshFile, recordFileEdit, withPathLocks } from '../file-freshness';
import {
  explainUnreadableMutationTarget,
  RegularFileWriteError,
  writeRegularFileAtomic,
} from '../fs-utils';
import { mutationSnapshot, snapshotFromBytes } from '../snapshot';
import { looksBinary } from './read-file';

const NEWLINE = 0x0a;

export async function editRuntimeFile(
  params: RuntimeEditFileParams
): Promise<RuntimeMutationResult<RuntimeEditFileResult>> {
  validateReplacement(params.oldString, params.newString);

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

    const source = Buffer.from(
      observed.bytes.buffer,
      observed.bytes.byteOffset,
      observed.bytes.byteLength
    );
    const oldBytes = Buffer.from(params.oldString);
    const newBytes = Buffer.from(params.newString);
    const matchOffsets = findMatchOffsets(source, oldBytes);
    if (matchOffsets.length === 0) {
      throw new RuntimeToolArgumentError(
        `The text to replace was not found in "${params.inputPath}". Re-read the file — it may ` +
          'have changed, or adjust oldString to match exactly (including whitespace).'
      );
    }
    if (matchOffsets.length > 1 && !params.replaceAll) {
      throw new RuntimeToolArgumentError(
        `Found ${matchOffsets.length} occurrences. Provide a longer oldString with more ` +
          'surrounding context to make it unique, or set replaceAll: true.'
      );
    }

    const selectedOffsets = params.replaceAll ? matchOffsets : [matchOffsets[0]];
    const updated = replaceAtOffsets(source, oldBytes.byteLength, newBytes, selectedOffsets);
    assertStillText(updated, params.inputPath);

    let committed: { mtimeMs: number };
    try {
      committed = await writeRegularFileAtomic(params.resolvedPath, updated);
    } catch (error) {
      if (error instanceof RegularFileWriteError) throw new PathAccessError(error.message);
      throw error;
    }

    const firstChangedLine = countLinesThroughOffset(source, selectedOffsets[0]);
    const lineCountChanged = countNewlines(oldBytes) !== countNewlines(newBytes);
    const sha256 = recordFileEdit(
      params.chatId,
      params.resolvedPath,
      updated,
      committed.mtimeMs,
      lineCountChanged ? firstChangedLine - 1 : Number.MAX_SAFE_INTEGER
    );
    return {
      result: {
        path: params.inputPath,
        replacements: selectedOffsets.length,
        sha256,
        firstChangedLine,
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
    `Refusing to edit "${inputPath}": newString contains a NUL byte, which would make the file ` +
      'unreadable by read_file and leave it unrecoverable by the file tools.'
  );
}

function validateReplacement(oldString: string, newString: string): void {
  if (oldString.length === 0) {
    throw new RuntimeToolArgumentError(
      'oldString must not be empty. Use create_file for a new file, or provide existing text to replace.'
    );
  }
  if (oldString === newString) {
    throw new RuntimeToolArgumentError('oldString and newString must be different.');
  }
}

function findMatchOffsets(source: Buffer, needle: Buffer): number[] {
  const offsets: number[] = [];
  for (
    let offset = source.indexOf(needle);
    offset !== -1;
    offset = source.indexOf(needle, offset + needle.byteLength)
  ) {
    offsets.push(offset);
  }
  return offsets;
}

function replaceAtOffsets(
  source: Buffer,
  oldByteLength: number,
  replacement: Buffer,
  offsets: readonly number[]
): Buffer {
  const chunks: Uint8Array[] = [];
  let cursor = 0;
  for (const offset of offsets) {
    chunks.push(source.subarray(cursor, offset), replacement);
    cursor = offset + oldByteLength;
  }
  chunks.push(source.subarray(cursor));
  return Buffer.concat(chunks);
}

function countNewlines(bytes: Buffer): number {
  let count = 0;
  for (
    let index = bytes.indexOf(NEWLINE);
    index !== -1;
    index = bytes.indexOf(NEWLINE, index + 1)
  ) {
    count++;
  }
  return count;
}

function countLinesThroughOffset(source: Buffer, offset: number): number {
  let line = 1;
  for (let index = source.indexOf(NEWLINE); index !== -1 && index < offset; ) {
    line++;
    index = source.indexOf(NEWLINE, index + 1);
  }
  return line;
}
