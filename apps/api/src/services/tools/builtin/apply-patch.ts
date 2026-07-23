/**
 * Built-in tool: apply_patch
 * Applies a multi-file V4A context patch after every operation is planned and
 * validated in memory.
 */

import { lstat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RegularFileWriteError, writeRegularFileAtomic } from '../../../lib/safe-file';
import { getRequiredTextArg, ToolArgumentError } from '../arg-parsing';
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
  type CapturedBefore,
  ensureFileMutationCheckpoint,
  hashFileAtPath,
  recordFileMutationAfterHash,
} from '../file-mutation-snapshot';
import { registerTool } from '../registry';
import type { ToolContext } from '../types';
import {
  assertRegularFilePath,
  explainUnreadableMutationTarget,
  isErrnoException,
  normalizePathValidationSettings,
  PathAccessError,
  type PathValidationSettings,
  pathPolicyParameterDescriptors,
  resolveAndValidatePath,
} from './_fs-utils';
import { parseV4aPatch, type V4aPatchOperation, type V4aUpdateHunk } from './_v4a-patch';
import { moveRegularFileWithoutOverwrite } from './move-file';

const APPLY_PATCH_TOOL_NAME = 'apply_patch';
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export interface ApplyPatchToolArgs {
  patch: string;
}

interface ApplyPatchFileResult {
  readonly path: string;
  readonly op: 'add' | 'update' | 'delete' | 'move';
  readonly movedTo?: string;
  readonly sha256?: string;
}

export interface ApplyPatchToolResult {
  readonly files: readonly ApplyPatchFileResult[];
  readonly summary: string;
}

export type ApplyPatchToolSettings = PathValidationSettings;

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
  /** Highest read_file line number the update leaves in place (see recordFileEdit). */
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

const definition = {
  name: APPLY_PATCH_TOOL_NAME,
  description:
    'Plans and validates one context-anchored patch across text files before writing any ' +
    'changes. Existing files must be read completely with read_file first. Format:\n' +
    '*** Begin Patch\n' +
    '*** Add File: path\n+new content\n' +
    '*** Update File: path\n*** Move to: new-path\n@@ optional context marker\n' +
    ' unchanged context\n-old text\n+new text\n' +
    '*** Delete File: path\n*** End Patch\n' +
    'Add-file lines require "+". Update lines require a leading space, "+", or "-". ' +
    'Move is optional and must immediately follow its Update header. Include enough unchanged ' +
    'context to identify each hunk uniquely; line numbers are not used.',
  parameters: {
    type: 'object',
    properties: {
      patch: {
        type: 'string',
        description: 'The complete V4A patch, including Begin Patch and End Patch lines.',
      },
    },
    required: ['patch'],
    additionalProperties: false,
  },
};

export function normalizeApplyPatchToolSettings(
  parameters: Record<string, unknown>
): ApplyPatchToolSettings {
  return normalizePathValidationSettings(parameters);
}

export async function executeApplyPatch(
  args: ApplyPatchToolArgs,
  context: ToolContext
): Promise<ApplyPatchToolResult> {
  const parsed = parseV4aPatch(args.patch);
  const settings = normalizeApplyPatchToolSettings(context.parameters);
  const planned = await planOperations(parsed.operations, settings, context);
  assertNoPathConflicts(planned);
  const lockedPaths = planned.flatMap(operationPaths);

  return await withPathLocks(lockedPaths, async () => {
    const revalidated = await revalidateOperations(planned, context);
    return await commitOperations(planned, revalidated, context);
  });
}

async function planOperations(
  operations: readonly V4aPatchOperation[],
  settings: ApplyPatchToolSettings,
  context: ToolContext
): Promise<PlannedOperation[]> {
  const settled = await Promise.allSettled(
    operations.map((operation) => planOperation(operation, settings, context))
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
  operation: V4aPatchOperation,
  settings: ApplyPatchToolSettings,
  context: ToolContext
): Promise<PlannedOperation> {
  const validationOptions = {
    settings,
    workdir: context.workdir,
    workdirPolicy: context.workdirPolicy,
  };
  const resolvedPath = resolveAndValidatePath(operation.path, validationOptions);

  if (operation.type === 'add') {
    assertTextContent(operation.content, operation.path);
    await assertDestinationAvailable(resolvedPath, operation.path);
    return {
      type: 'add',
      inputPath: operation.path,
      resolvedPath,
      content: operation.content,
    };
  }

  const source = await readFreshPatchTarget(resolvedPath, context);
  if (operation.type === 'delete') {
    return {
      type: 'delete',
      inputPath: operation.path,
      resolvedPath,
      source: source.bytes,
    };
  }

  let sourceText: string;
  try {
    sourceText = textDecoder.decode(source.bytes);
  } catch {
    throw new PathAccessError(
      `Cannot patch "${operation.path}": the file is not valid UTF-8 text.`
    );
  }
  const { content, lineNumbersValidThroughLine } = applyUpdateHunks(
    sourceText,
    operation.hunks,
    operation.path
  );
  assertTextContent(content, operation.path);
  if (!operation.moveTo) {
    return {
      type: 'update',
      inputPath: operation.path,
      resolvedPath,
      source: source.bytes,
      content,
      hasContentChanges: operation.hunks.length > 0,
      lineNumbersValidThroughLine,
    };
  }

  const resolvedMoveTo = resolveAndValidatePath(operation.moveTo, validationOptions);
  if (resolvedMoveTo === resolvedPath) {
    throw new PathAccessError('Source and move destination must be different paths.');
  }
  await assertDestinationAvailable(resolvedMoveTo, operation.moveTo);
  return {
    type: 'update',
    inputPath: operation.path,
    resolvedPath,
    moveTo: operation.moveTo,
    resolvedMoveTo,
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
      if (owner) {
        failures.push(`${description}: path conflicts with ${owner}.`);
      } else {
        owners.set(path, description);
      }
    }
  }
  if (failures.length > 0) throwPatchFailureMessages(failures);
}

async function revalidateOperations(
  planned: readonly PlannedOperation[],
  context: ToolContext
): Promise<Map<PlannedUpdate | PlannedDelete, RevalidatedUpdate>> {
  const settled = await Promise.allSettled(
    planned.map(async (operation) => {
      if (operation.type === 'add') {
        await assertDestinationAvailable(operation.resolvedPath, operation.inputPath);
        return null;
      }

      const source = await readFreshPatchTarget(operation.resolvedPath, context);
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
  context: ToolContext
): Promise<ApplyPatchToolResult> {
  // One snapshot per planned operation, kept by operation: the after-hash pass
  // below completes each row, and a path can appear more than once in a patch.
  const captured = new Map<PlannedOperation, CapturedBefore>();
  for (const operation of planned) {
    if (operation.type === 'add') {
      captured.set(
        operation,
        await ensureFileMutationCheckpoint(context, operation.resolvedPath, 'create')
      );
    } else if (operation.type === 'delete') {
      captured.set(
        operation,
        await ensureFileMutationCheckpoint(context, operation.resolvedPath, 'delete')
      );
    } else if (operation.resolvedMoveTo) {
      captured.set(
        operation,
        await ensureFileMutationCheckpoint(context, operation.resolvedPath, 'move', {
          movedTo: operation.resolvedMoveTo,
        })
      );
    } else {
      captured.set(
        operation,
        await ensureFileMutationCheckpoint(context, operation.resolvedPath, 'edit')
      );
    }
  }

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

  const files = await Promise.all(
    planned.map(async (operation): Promise<ApplyPatchFileResult> => {
      const capturedBefore = captured.get(operation);
      if (!capturedBefore) throw new Error(`Missing checkpoint for "${operation.inputPath}".`);

      if (operation.type === 'delete') {
        forgetFile(context.chatId, operation.resolvedPath);
        await recordFileMutationAfterHash(context, capturedBefore, null);
        return { path: operation.inputPath, op: 'delete' };
      }

      if (operation.type === 'add') {
        const committed = writes.get(operation);
        if (!committed) throw new Error(`Missing committed write for "${operation.inputPath}".`);
        const sha256 = recordFileRead(
          context.chatId,
          operation.resolvedPath,
          operation.content,
          committed.mtimeMs
        );
        await recordFileMutationAfterHash(context, capturedBefore, sha256);
        return { path: operation.inputPath, op: 'add', sha256 };
      }

      const target = operation.resolvedMoveTo ?? operation.resolvedPath;
      const written = writes.get(operation);
      const current = revalidated.get(operation);
      if (!current) throw new Error(`Missing revalidation for "${operation.inputPath}".`);
      if (operation.resolvedMoveTo) rekeyFile(context.chatId, operation.resolvedPath, target);
      const mtimeMs = written?.mtimeMs ?? current.mtimeMs;
      // A content change renumbers every line after the first splice, so record the
      // shift the way edit_file/replace_range do — otherwise a later line-addressed
      // edit would trust the pre-patch numbering and hit the wrong lines. A pure
      // move leaves the numbering intact, so it stays a whole-content observation.
      const sha256 = operation.hasContentChanges
        ? recordFileEdit(
            context.chatId,
            target,
            operation.content,
            mtimeMs,
            operation.lineNumbersValidThroughLine
          )
        : recordFileRead(context.chatId, target, current.bytes, mtimeMs);
      if (operation.resolvedMoveTo) {
        const afterHash = (await hashFileAtPath(target)) ?? sha256;
        await recordFileMutationAfterHash(context, capturedBefore, afterHash);
      } else {
        await recordFileMutationAfterHash(context, capturedBefore, sha256);
      }
      return operation.moveTo
        ? { path: operation.inputPath, op: 'move', movedTo: operation.moveTo, sha256 }
        : { path: operation.inputPath, op: 'update', sha256 };
    })
  );

  return {
    files,
    summary: `${files.length} ${files.length === 1 ? 'file' : 'files'} changed`,
  };
}

async function readFreshPatchTarget(
  resolvedPath: string,
  context: ToolContext
): ReturnType<typeof readFreshFile> {
  await assertRegularFilePath(resolvedPath, 'patch');
  try {
    return await readFreshFile(context.chatId, resolvedPath);
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
  hunks: readonly V4aUpdateHunk[],
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

/**
 * Count of leading lines that kept both their content and their position, so the
 * model's read_file line numbers still address them. The first differing line is
 * where a splice may have renumbered everything after it, which a later
 * line-addressed edit must not trust; a shorter prefix only forces an extra
 * re-read, never a wrong edit.
 */
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

function locateHunk(
  source: readonly TextLine[],
  hunk: V4aUpdateHunk,
  inputPath: string,
  hunkNumber: number
): number {
  const exact = findHunkCandidates(source, hunk, false);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throwAmbiguousHunk(inputPath, hunkNumber);

  const whitespaceLenient = findHunkCandidates(source, hunk, true);
  if (whitespaceLenient.length === 1) return whitespaceLenient[0];
  if (whitespaceLenient.length > 1) throwAmbiguousHunk(inputPath, hunkNumber);
  throw new ToolArgumentError(
    `Hunk ${hunkNumber} for "${inputPath}": context not found. ` +
      'Re-read the file and regenerate the patch.'
  );
}

function findHunkCandidates(
  source: readonly TextLine[],
  hunk: V4aUpdateHunk,
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
  if (!ignoreTrailingWhitespace) return left === right;
  return left.trimEnd() === right.trimEnd();
}

function applyHunkAt(
  source: readonly TextLine[],
  hunk: V4aUpdateHunk,
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
  throw new ToolArgumentError(
    `Hunk ${hunkNumber} for "${inputPath}": context matches multiple locations. ` +
      'Add more surrounding context or an @@ marker.'
  );
}

function assertTextContent(content: string, inputPath: string): void {
  if (!content.includes('\0')) return;
  throw new ToolArgumentError(
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

function describeOperation(operation: V4aPatchOperation): string {
  const label =
    operation.type === 'add' ? 'Add' : operation.type === 'delete' ? 'Delete' : 'Update';
  return `${label} "${operation.path}"`;
}

function describePlannedOperation(operation: PlannedOperation): string {
  const label =
    operation.type === 'add' ? 'Add' : operation.type === 'delete' ? 'Delete' : 'Update';
  return `${label} "${operation.inputPath}"`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  throw new ToolArgumentError(
    `Patch could not be applied:\n${failures.map((x) => `- ${x}`).join('\n')}`
  );
}

function throwCommitError(changedPaths: readonly string[], cause: unknown): never {
  const changed =
    changedPaths.length > 0
      ? ` Paths already modified: ${[...new Set(changedPaths)].map((path) => `"${path}"`).join(', ')}.`
      : '';
  throw new PathAccessError(
    `Patch commit failed.${changed} Inspect any listed paths before retrying. Cause: ${errorMessage(cause)}`
  );
}

function execute(
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ApplyPatchToolResult> {
  const patch = getRequiredTextArg(args.patch, 'patch');
  return executeApplyPatch({ patch }, context);
}

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool({
    definition,
    settings: {
      title: 'Apply patch',
      description:
        'Allows the AI to apply context-anchored changes across multiple text files at once.',
      category: 'system',
      enabledByDefault: true,
      canDisable: true,
      defaultParameters: {
        allowedPaths: [],
        deniedPaths: [],
      },
      parameterDescriptors: pathPolicyParameterDescriptors(
        'List of paths where the tool may apply patches. Leave empty to allow all.',
        'List of paths where the tool may not apply patches. Leave empty to deny none.'
      ),
    },
    execute,
  });
}
