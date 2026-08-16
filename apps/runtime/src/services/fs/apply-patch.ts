import { lstat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PathAccessError, RuntimeToolArgumentError } from '../../errors';
import type {
  RuntimeApplyPatchParams,
  RuntimeApplyPatchResult,
  RuntimeMutationResult,
  RuntimeMutationSnapshot,
  RuntimePatchHunk,
  RuntimePatchOperation,
} from '../../methods';
import { throwIfAborted } from '../cancellation';
import {
  FileNotReadError,
  forgetFile,
  readFreshFile,
  recordFileEdit,
  recordFileRead,
  rekeyFile,
  StaleFileError,
  withPathLocks,
} from '../file-freshness';
import {
  assertRegularFilePath,
  explainUnreadableMutationTarget,
  isErrnoException,
  moveRegularFileWithoutOverwrite,
  RegularFileWriteError,
  writeRegularFileAtomic,
} from '../fs-utils';
import { hashFileAtPath, mutationSnapshot, snapshotFromBytes } from '../snapshot';

const textDecoder = new TextDecoder('utf-8', { fatal: true });

interface PlannedAdd {
  readonly type: 'add';
  readonly inputPath: string;
  readonly resolvedPath: string;
  readonly content: string;
}

interface PlannedDelete {
  readonly type: 'delete';
  readonly inputPath: string;
  readonly resolvedPath: string;
  readonly source: Uint8Array;
}

interface PlannedUpdate {
  readonly type: 'update';
  readonly inputPath: string;
  readonly resolvedPath: string;
  readonly moveTo?: string;
  readonly resolvedMoveTo?: string;
  readonly source: Uint8Array;
  readonly content: string;
  readonly hasContentChanges: boolean;
  readonly lineNumbersValidThroughLine: number;
}

type PlannedOperation = PlannedAdd | PlannedDelete | PlannedUpdate;

interface OperationFailure {
  readonly description: string;
  readonly error: unknown;
}

interface RevalidatedUpdate {
  readonly bytes: Uint8Array;
  readonly mtimeMs: number;
  readonly mode: number;
}

interface CommittedWrite {
  readonly mtimeMs: number;
}

export async function applyRuntimePatch(
  params: RuntimeApplyPatchParams,
  signal?: AbortSignal
): Promise<RuntimeMutationResult<RuntimeApplyPatchResult>> {
  throwIfAborted(signal);
  const planned = await planOperations(params.operations, params.chatId);
  assertNoPathConflicts(planned);
  const lockedPaths = planned.flatMap(operationPaths);

  return await withPathLocks(lockedPaths, async () => {
    const revalidated = await revalidateOperations(planned, params.chatId);
    // A patch commits several files as one change, so this is the only point at
    // which it can be refused. Once the first write lands, stopping would leave
    // the operations half applied.
    throwIfAborted(signal);
    return await commitOperations(planned, revalidated, params);
  });
}

async function planOperations(
  operations: readonly RuntimePatchOperation[],
  chatId: string
): Promise<PlannedOperation[]> {
  const settled = await Promise.allSettled(
    operations.map((operation) => planOperation(operation, chatId))
  );
  const failures = settled.flatMap((result, index) =>
    result.status === 'rejected'
      ? [{ description: describeOperation(operations[index]), error: result.reason }]
      : []
  );
  if (failures.length > 0) throwOperationFailures(failures);
  return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
}

async function planOperation(
  operation: RuntimePatchOperation,
  chatId: string
): Promise<PlannedOperation> {
  if (operation.type === 'add') {
    assertTextContent(operation.content, operation.inputPath);
    await assertDestinationAvailable(operation.resolvedPath, operation.inputPath);
    return operation;
  }

  const source = await readFreshPatchTarget(operation.resolvedPath, chatId);
  if (operation.type === 'delete') {
    return { ...operation, source: source.bytes };
  }

  let sourceText: string;
  try {
    sourceText = textDecoder.decode(source.bytes);
  } catch {
    throw new PathAccessError(
      `Cannot patch "${operation.inputPath}": the file is not valid UTF-8 text.`
    );
  }
  const { content, lineNumbersValidThroughLine } = applyUpdateHunks(
    sourceText,
    operation.hunks,
    operation.inputPath
  );
  assertTextContent(content, operation.inputPath);
  if (operation.resolvedMoveTo && operation.moveTo) {
    if (operation.resolvedMoveTo === operation.resolvedPath) {
      throw new PathAccessError('Source and move destination must be different paths.');
    }
    await assertDestinationAvailable(operation.resolvedMoveTo, operation.moveTo);
  }
  return {
    ...operation,
    source: source.bytes,
    content,
    hasContentChanges: operation.hunks.length > 0,
    lineNumbersValidThroughLine,
  };
}

function assertNoPathConflicts(planned: readonly PlannedOperation[]): void {
  const owners = new Map<string, string>();
  const failures: string[] = [];
  for (const operation of planned) {
    const description = describePlannedOperation(operation);
    for (const path of operationPaths(operation)) {
      const owner = owners.get(path);
      if (owner) failures.push(`${description}: path conflicts with ${owner}.`);
      else owners.set(path, description);
    }
  }
  if (failures.length > 0) throwPatchFailureMessages(failures);
}

async function revalidateOperations(
  planned: readonly PlannedOperation[],
  chatId: string
): Promise<Map<PlannedUpdate | PlannedDelete, RevalidatedUpdate>> {
  const settled = await Promise.allSettled(
    planned.map(async (operation) => {
      if (operation.type === 'add') {
        await assertDestinationAvailable(operation.resolvedPath, operation.inputPath);
        return null;
      }

      const source = await readFreshPatchTarget(operation.resolvedPath, chatId);
      if (!bytesEqual(source.bytes, operation.source)) {
        throw new StaleFileError(operation.resolvedPath);
      }
      if (operation.type === 'update' && operation.resolvedMoveTo && operation.moveTo) {
        await assertDestinationAvailable(operation.resolvedMoveTo, operation.moveTo);
      }
      const entry = await assertRegularFilePath(operation.resolvedPath, 'patch');
      return {
        operation,
        revalidated: {
          bytes: source.bytes,
          mtimeMs: source.mtimeMs,
          mode: entry.mode & 0o7777,
        },
      };
    })
  );
  const failures = settled.flatMap((result, index) =>
    result.status === 'rejected'
      ? [{ description: describePlannedOperation(planned[index]), error: result.reason }]
      : []
  );
  if (failures.length > 0) throwOperationFailures(failures);

  const revalidated = new Map<PlannedUpdate | PlannedDelete, RevalidatedUpdate>();
  for (const result of settled) {
    if (result.status === 'fulfilled' && result.value) {
      revalidated.set(result.value.operation, result.value.revalidated);
    }
  }
  return revalidated;
}

async function commitOperations(
  planned: readonly PlannedOperation[],
  revalidated: ReadonlyMap<PlannedUpdate | PlannedDelete, RevalidatedUpdate>,
  params: RuntimeApplyPatchParams
): Promise<RuntimeMutationResult<RuntimeApplyPatchResult>> {
  const writes = new Map<PlannedAdd | PlannedUpdate, CommittedWrite>();
  const changedPaths: string[] = [];
  try {
    for (const operation of planned) {
      if (operation.type === 'delete') continue;
      if (operation.type === 'update' && !operation.hasContentChanges) continue;
      const committed = await writeRegularFileAtomic(
        operation.resolvedPath,
        operation.content,
        operation.type === 'add' ? { exclusive: true } : {}
      );
      writes.set(operation, committed);
      changedPaths.push(operation.resolvedPath);
    }

    for (const operation of planned) {
      if (operation.type !== 'update' || !operation.resolvedMoveTo) continue;
      const current = revalidated.get(operation);
      if (!current) throw new Error(`Missing revalidation for "${operation.inputPath}".`);
      await moveRegularFileWithoutOverwrite(
        operation.resolvedPath,
        operation.resolvedMoveTo,
        current.mode
      );
      changedPaths.push(operation.resolvedMoveTo);
    }

    for (const operation of planned) {
      if (operation.type !== 'delete') continue;
      try {
        await unlink(operation.resolvedPath);
      } catch (error) {
        if (isErrnoException(error, 'ENOENT')) throw new StaleFileError(operation.resolvedPath);
        throw error;
      }
      changedPaths.push(operation.resolvedPath);
    }
  } catch (error) {
    if (error instanceof RegularFileWriteError) {
      throwCommitError(changedPaths, new PathAccessError(error.message));
    }
    throwCommitError(changedPaths, error);
  }

  const outcomes = await Promise.all(
    planned.map(
      async (
        operation
      ): Promise<{
        file: RuntimeApplyPatchResult['files'][number];
        mutations: readonly RuntimeMutationSnapshot[];
      }> => {
        if (operation.type === 'delete') {
          const current = revalidated.get(operation);
          if (!current) throw new Error(`Missing revalidation for "${operation.inputPath}".`);
          forgetFile(params.chatId, operation.resolvedPath);
          return {
            file: { path: operation.inputPath, op: 'delete' },
            mutations: mutationSnapshot(params.captureSnapshot, {
              path: operation.resolvedPath,
              op: 'delete',
              before: snapshotFromBytes(current.bytes),
              afterHash: null,
            }),
          };
        }

        if (operation.type === 'add') {
          const committed = writes.get(operation);
          if (!committed) throw new Error(`Missing committed write for "${operation.inputPath}".`);
          const sha256 = recordFileRead(
            params.chatId,
            operation.resolvedPath,
            operation.content,
            committed.mtimeMs
          );
          return {
            file: { path: operation.inputPath, op: 'add', sha256 },
            mutations: mutationSnapshot(params.captureSnapshot, {
              path: operation.resolvedPath,
              op: 'create',
              before: { exists: false },
              afterHash: sha256,
            }),
          };
        }

        const target = operation.resolvedMoveTo ?? operation.resolvedPath;
        const written = writes.get(operation);
        const current = revalidated.get(operation);
        if (!current) throw new Error(`Missing revalidation for "${operation.inputPath}".`);
        if (operation.resolvedMoveTo) {
          rekeyFile(params.chatId, operation.resolvedPath, target);
        }
        const mtimeMs = written?.mtimeMs ?? current.mtimeMs;
        const sha256 = operation.hasContentChanges
          ? recordFileEdit(
              params.chatId,
              target,
              operation.content,
              mtimeMs,
              operation.lineNumbersValidThroughLine
            )
          : recordFileRead(params.chatId, target, current.bytes, mtimeMs);
        const afterHash = operation.resolvedMoveTo
          ? ((await hashFileAtPath(target)) ?? sha256)
          : sha256;
        return {
          file: operation.moveTo
            ? {
                path: operation.inputPath,
                op: 'move',
                movedTo: operation.moveTo,
                sha256,
              }
            : { path: operation.inputPath, op: 'update', sha256 },
          mutations: mutationSnapshot(params.captureSnapshot, {
            path: operation.resolvedPath,
            op: operation.resolvedMoveTo ? 'move' : 'edit',
            ...(operation.resolvedMoveTo ? { movedTo: target } : {}),
            before: snapshotFromBytes(current.bytes),
            afterHash,
          }),
        };
      }
    )
  );
  const files = outcomes.map(({ file }) => file);

  return {
    result: {
      files,
      summary: `${files.length} ${files.length === 1 ? 'file' : 'files'} changed`,
    },
    mutations: outcomes.flatMap(({ mutations }) => mutations),
  };
}

async function readFreshPatchTarget(resolvedPath: string, chatId: string) {
  await assertRegularFilePath(resolvedPath, 'patch');
  try {
    return await readFreshFile(chatId, resolvedPath);
  } catch (error) {
    if (error instanceof FileNotReadError) {
      throw await explainUnreadableMutationTarget(resolvedPath, 'patch', error);
    }
    throw error;
  }
}

async function assertDestinationAvailable(resolvedPath: string, inputPath: string): Promise<void> {
  const destination = await lstat(resolvedPath).catch((error: unknown) => {
    if (isErrnoException(error, 'ENOENT')) return null;
    throw error;
  });
  if (destination) {
    throw new PathAccessError(`"${inputPath}" already exists and cannot be overwritten.`);
  }

  let parent = dirname(resolvedPath);
  while (true) {
    const entry = await lstat(parent).catch((error: unknown) => {
      if (isErrnoException(error, 'ENOENT')) return null;
      throw error;
    });
    if (entry) {
      if (!entry.isDirectory()) {
        throw new PathAccessError(
          `Cannot create "${inputPath}": parent path "${parent}" is not a directory.`
        );
      }
      return;
    }
    const next = dirname(parent);
    if (next === parent) return;
    parent = next;
  }
}

function applyUpdateHunks(
  source: string,
  hunks: readonly RuntimePatchHunk[],
  inputPath: string
): { content: string; lineNumbersValidThroughLine: number } {
  const original = splitTextLines(source);
  let lines = original;
  for (let index = 0; index < hunks.length; index++) {
    const hunk = hunks[index];
    const location = locateHunk(lines, hunk, inputPath, index + 1);
    lines = applyHunkAt(lines, hunk, location);
  }
  return {
    content: lines.map((line) => line.content + line.ending).join(''),
    lineNumbersValidThroughLine: unchangedPrefixLength(original, lines),
  };
}

interface TextLine {
  readonly content: string;
  readonly ending: '' | '\n' | '\r\n';
}

function splitTextLines(input: string): TextLine[] {
  const lines: TextLine[] = [];
  let start = 0;
  while (start < input.length) {
    const newline = input.indexOf('\n', start);
    if (newline === -1) {
      lines.push({ content: input.slice(start), ending: '' });
      break;
    }
    const isCrLf = newline > start && input[newline - 1] === '\r';
    lines.push({
      content: input.slice(start, isCrLf ? newline - 1 : newline),
      ending: isCrLf ? '\r\n' : '\n',
    });
    start = newline + 1;
  }
  return lines;
}

function unchangedPrefixLength(before: readonly TextLine[], after: readonly TextLine[]): number {
  const limit = Math.min(before.length, after.length);
  let index = 0;
  while (
    index < limit &&
    before[index].content === after[index].content &&
    before[index].ending === after[index].ending
  ) {
    index++;
  }
  return index;
}

function locateHunk(
  source: readonly TextLine[],
  hunk: RuntimePatchHunk,
  inputPath: string,
  hunkNumber: number
): number {
  const exact = findHunkCandidates(source, hunk, false);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throwAmbiguousHunk(inputPath, hunkNumber);

  const lenient = findHunkCandidates(source, hunk, true);
  if (lenient.length === 1) return lenient[0];
  if (lenient.length > 1) throwAmbiguousHunk(inputPath, hunkNumber);
  throw new RuntimeToolArgumentError(
    `Hunk ${hunkNumber} for "${inputPath}": context not found. ` +
      'Re-read the file and regenerate the patch.'
  );
}

function findHunkCandidates(
  source: readonly TextLine[],
  hunk: RuntimePatchHunk,
  ignoreTrailingWhitespace: boolean
): number[] {
  const oldLines = hunk.lines.filter((line) => line.type !== 'add').map((line) => line.content);
  const windows = findMarkerWindows(source, hunk.marker, ignoreTrailingWhitespace);
  if (oldLines.length === 0) return windows.map((window) => window.start);

  const candidates = new Set<number>();
  for (const window of windows) {
    for (let start = window.start; start + oldLines.length <= window.end; start++) {
      const matches = oldLines.every((line, index) =>
        linesEqual(source[start + index]?.content ?? '', line, ignoreTrailingWhitespace)
      );
      if (matches) candidates.add(start);
    }
  }
  return [...candidates];
}

function findMarkerWindows(
  source: readonly TextLine[],
  marker: string | undefined,
  ignoreTrailingWhitespace: boolean
): Array<{ start: number; end: number }> {
  if (!marker) return [{ start: 0, end: source.length }];
  const markerIndexes = source.flatMap((line, index) =>
    linesEqual(line.content, marker, ignoreTrailingWhitespace) ? [index] : []
  );
  return markerIndexes.map((markerIndex, index) => ({
    start: markerIndex + 1,
    end: markerIndexes[index + 1] ?? source.length,
  }));
}

function linesEqual(left: string, right: string, ignoreTrailingWhitespace: boolean): boolean {
  return ignoreTrailingWhitespace ? left.trimEnd() === right.trimEnd() : left === right;
}

function applyHunkAt(
  source: readonly TextLine[],
  hunk: RuntimePatchHunk,
  location: number
): TextLine[] {
  const replacement: TextLine[] = [];
  let cursor = location;
  for (const line of hunk.lines) {
    if (line.type === 'add') {
      replacement.push({ content: line.content, ending: line.ending });
      continue;
    }
    if (line.type === 'context') replacement.push(source[cursor]);
    cursor++;
  }
  return [...source.slice(0, location), ...replacement, ...source.slice(cursor)];
}

function throwAmbiguousHunk(inputPath: string, hunkNumber: number): never {
  throw new RuntimeToolArgumentError(
    `Hunk ${hunkNumber} for "${inputPath}": context matches multiple locations. ` +
      'Add more surrounding context or an @@ marker.'
  );
}

function assertTextContent(content: string, inputPath: string): void {
  if (!content.includes('\0')) return;
  throw new RuntimeToolArgumentError(
    `Refusing to patch "${inputPath}": the result contains a NUL byte and would not be a text file.`
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.compare(left, right) === 0;
}

function operationPaths(operation: PlannedOperation): string[] {
  return operation.type === 'update' && operation.resolvedMoveTo
    ? [operation.resolvedPath, operation.resolvedMoveTo]
    : [operation.resolvedPath];
}

function describeOperation(operation: RuntimePatchOperation): string {
  const label =
    operation.type === 'add' ? 'Add' : operation.type === 'delete' ? 'Delete' : 'Update';
  return `${label} "${operation.inputPath}"`;
}

function describePlannedOperation(operation: PlannedOperation): string {
  const label =
    operation.type === 'add' ? 'Add' : operation.type === 'delete' ? 'Delete' : 'Update';
  return `${label} "${operation.inputPath}"`;
}

function throwOperationFailures(failures: readonly OperationFailure[]): never {
  const [failure] = failures;
  if (failures.length === 1 && failure?.error instanceof Error) {
    failure.error.message = `Patch could not be applied:\n- ${failure.description}: ${failure.error.message}`;
    throw failure.error;
  }
  throwPatchFailureMessages(
    failures.map((failure) => `${failure.description}: ${errorMessage(failure.error)}`)
  );
}

function throwPatchFailureMessages(failures: readonly string[]): never {
  throw new RuntimeToolArgumentError(
    `Patch could not be applied:\n${failures.map((failure) => `- ${failure}`).join('\n')}`
  );
}

function throwCommitError(changedPaths: readonly string[], cause: unknown): never {
  const unique = [...new Set(changedPaths)];
  const changed =
    unique.length > 0
      ? ` Paths already modified: ${unique.map((path) => `"${path}"`).join(', ')}.`
      : '';
  throw new PathAccessError(
    `Patch commit failed.${changed} Inspect any listed paths before retrying. Cause: ${errorMessage(cause)}`,
    unique.length > 0 ? { changedPaths: unique } : {}
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
