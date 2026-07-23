/**
 * Built-in tool: edit_file
 * Replaces exact text in an existing file without rewriting it from model output.
 */

import { RegularFileWriteError, writeRegularFileAtomic } from '../../../lib/safe-file';
import { getOptionalBoolean, getRequiredTextArg, ToolArgumentError } from '../arg-parsing';
import { FileNotReadError, readFreshFile, recordFileEdit, withPathLocks } from '../file-freshness';
import {
  ensureFileMutationCheckpoint,
  recordFileMutationAfterHash,
} from '../file-mutation-snapshot';
import { registerTool } from '../registry';
import type { ToolContext } from '../types';
import {
  explainUnreadableMutationTarget,
  getRequiredPathArg,
  normalizePathValidationSettings,
  PathAccessError,
  type PathValidationSettings,
  pathPolicyParameterDescriptors,
  resolveAndValidatePath,
} from './_fs-utils';
import { looksBinary } from './read-file';

const EDIT_FILE_TOOL_NAME = 'edit_file';
const NEWLINE = 0x0a;

export interface EditFileToolArgs {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export interface EditFileToolResult {
  path: string;
  replacements: number;
  sha256: string;
  firstChangedLine: number;
}

export type EditFileToolSettings = PathValidationSettings;

const definition = {
  name: EDIT_FILE_TOOL_NAME,
  description:
    'Replaces exact text in an existing text file. The file must be read completely with ' +
    'read_file first. oldString must match exactly, including whitespace and line endings. ' +
    'It must occur at least once and be unique by default; set replaceAll to true to replace ' +
    'every non-overlapping occurrence.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path, ~ path, or path relative to the chat working directory.',
      },
      oldString: {
        type: 'string',
        description: 'Exact text to replace, including whitespace and line endings.',
      },
      newString: {
        type: 'string',
        description: 'Exact replacement text. May be empty to delete the matched text.',
      },
      replaceAll: {
        type: 'boolean',
        description: 'Replace every occurrence instead of requiring one unique match.',
        default: false,
      },
    },
    required: ['path', 'oldString', 'newString'],
    additionalProperties: false,
  },
};

export function normalizeEditFileToolSettings(
  parameters: Record<string, unknown>
): EditFileToolSettings {
  return normalizePathValidationSettings(parameters);
}

export async function executeEditFile(
  args: EditFileToolArgs,
  context: ToolContext
): Promise<EditFileToolResult> {
  validateReplacement(args.oldString, args.newString);
  const settings = normalizeEditFileToolSettings(context.parameters);
  const resolvedPath = resolveAndValidatePath(args.path, {
    settings,
    workdir: context.workdir,
    workdirPolicy: context.workdirPolicy,
  });

  return await withPathLocks([resolvedPath], async () => {
    let observed: Awaited<ReturnType<typeof readFreshFile>>;
    try {
      observed = await readFreshFile(context.chatId, resolvedPath);
    } catch (error) {
      if (error instanceof FileNotReadError) {
        throw await explainUnreadableMutationTarget(resolvedPath, 'edit', error);
      }
      throw error;
    }

    const captured = await ensureFileMutationCheckpoint(context, resolvedPath, 'edit');

    const { bytes } = observed;
    const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const oldBytes = Buffer.from(args.oldString);
    const newBytes = Buffer.from(args.newString);
    const matchOffsets = findMatchOffsets(source, oldBytes);

    if (matchOffsets.length === 0) {
      throw new ToolArgumentError(
        `The text to replace was not found in "${args.path}". Re-read the file — it may ` +
          'have changed, or adjust oldString to match exactly (including whitespace).'
      );
    }
    if (matchOffsets.length > 1 && !args.replaceAll) {
      throw new ToolArgumentError(
        `Found ${matchOffsets.length} occurrences. Provide a longer oldString with more ` +
          'surrounding context to make it unique, or set replaceAll: true.'
      );
    }

    const selectedOffsets = args.replaceAll ? matchOffsets : [matchOffsets[0]];
    const updated = replaceAtOffsets(source, oldBytes.byteLength, newBytes, selectedOffsets);
    assertStillText(updated, args.path);

    let committed: { mtimeMs: number };
    try {
      committed = await writeRegularFileAtomic(resolvedPath, updated);
    } catch (error) {
      if (error instanceof RegularFileWriteError) throw new PathAccessError(error.message);
      throw error;
    }

    // Swapping in a different number of newlines renumbers the file from the
    // first match down, which replace_range has to know about before it trusts
    // line numbers the model took from the last read.
    const firstChangedLine = countLinesThroughOffset(source, selectedOffsets[0]);
    const lineCountChanged = countNewlines(oldBytes) !== countNewlines(newBytes);
    const sha256 = recordFileEdit(
      context.chatId,
      resolvedPath,
      updated,
      committed.mtimeMs,
      lineCountChanged ? firstChangedLine - 1 : Number.MAX_SAFE_INTEGER
    );
    await recordFileMutationAfterHash(context, captured, sha256);
    return {
      path: args.path,
      replacements: selectedOffsets.length,
      sha256,
      firstChangedLine,
    };
  });
}

/**
 * Refuses an edit whose result read_file would classify as binary. Writing a NUL
 * byte into a text file strands it: read_file then refuses it forever, and every
 * mutation tool gates on that read, so nothing could repair or delete it again.
 */
function assertStillText(updated: Uint8Array, inputPath: string): void {
  if (!looksBinary(updated)) return;
  throw new ToolArgumentError(
    `Refusing to edit "${inputPath}": newString contains a NUL byte, which would make the file ` +
      'unreadable by read_file and leave it unrecoverable by the file tools.'
  );
}

function validateReplacement(oldString: string, newString: string): void {
  if (oldString.length === 0) {
    throw new ToolArgumentError(
      'oldString must not be empty. Use create_file for a new file, or provide existing text to replace.'
    );
  }
  if (oldString === newString) {
    throw new ToolArgumentError('oldString and newString must be different.');
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

/** Counts newlines in a needle or replacement, never in the whole file. */
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

function execute(args: Record<string, unknown>, context: ToolContext): Promise<EditFileToolResult> {
  const path = getRequiredPathArg(args.path, 'path');
  const oldString = getRequiredTextArg(args.oldString, 'oldString');
  const newString = getRequiredTextArg(args.newString, 'newString');
  const replaceAll = getOptionalBoolean(args.replaceAll, 'replaceAll');
  return executeEditFile(
    { path, oldString, newString, ...(replaceAll !== undefined ? { replaceAll } : {}) },
    context
  );
}

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool({
    definition,
    settings: {
      title: 'Edit file',
      description: 'Allows the AI to replace exact text in files it has read in this chat.',
      category: 'system',
      enabledByDefault: true,
      canDisable: true,
      defaultParameters: {
        allowedPaths: [],
        deniedPaths: [],
      },
      parameterDescriptors: pathPolicyParameterDescriptors(
        'List of paths where the tool is allowed to edit files. Leave empty to allow all.',
        'List of paths where the tool is denied from editing files. Leave empty to deny none.'
      ),
    },
    execute,
  });
}
