/**
 * Built-in tool: replace_range
 * Replaces an inclusive range of lines in an existing file.
 */

import { RegularFileWriteError, writeRegularFileAtomic } from '../../../lib/safe-file';
import { getRequiredInteger, getRequiredTextArg, ToolArgumentError } from '../arg-parsing';
import {
  assertLineNumbersCurrent,
  FileNotReadError,
  readFreshFile,
  recordFileEdit,
  withPathLocks,
} from '../file-freshness';
import {
  attachBeforeFields,
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
import { countTotalLines, looksBinary } from './read-file';

const REPLACE_RANGE_TOOL_NAME = 'replace_range';
const NEWLINE = 0x0a;

export interface ReplaceRangeToolArgs {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface ReplaceRangeToolResult {
  path: string;
  replacedLines: number;
  newTotalLines: number;
  sha256: string;
  before?: string;
  beforeOmitted?: 'binary' | 'too_large' | 'missing';
}

export type ReplaceRangeToolSettings = PathValidationSettings;

const definition = {
  name: REPLACE_RANGE_TOOL_NAME,
  description:
    'Replaces a 1-indexed inclusive line range in an existing text file. Line numbers refer ' +
    'to the file as last read with read_file. The file must be read completely first. If the ' +
    'file is stale, re-read it before retrying. The replacement may contain any number of lines ' +
    'or be empty to delete the range. A call that changes the line count renumbers every line ' +
    'after the range it replaced, so the tool then refuses later ranges reaching past that ' +
    'point until the file is read again.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path, ~ path, or path relative to the chat working directory.',
      },
      startLine: {
        type: 'integer',
        minimum: 1,
        description: 'First line to replace, using 1-indexed inclusive line numbers.',
      },
      endLine: {
        type: 'integer',
        minimum: 1,
        description: 'Last line to replace, using 1-indexed inclusive line numbers.',
      },
      content: {
        type: 'string',
        description: 'Replacement text. Use an empty string to delete the selected lines.',
      },
    },
    required: ['path', 'startLine', 'endLine', 'content'],
    additionalProperties: false,
  },
};

export function normalizeReplaceRangeToolSettings(
  parameters: Record<string, unknown>
): ReplaceRangeToolSettings {
  return normalizePathValidationSettings(parameters);
}

export async function executeReplaceRange(
  args: ReplaceRangeToolArgs,
  context: ToolContext
): Promise<ReplaceRangeToolResult> {
  const settings = normalizeReplaceRangeToolSettings(context.parameters);
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
    assertLineNumbersCurrent(context.chatId, resolvedPath, args.endLine);

    const captured = await ensureFileMutationCheckpoint(context, resolvedPath, 'edit');

    const { bytes } = observed;
    // One logical line per split entry, so the split doubles as the line count.
    const sourceLines = splitLines(bytes);
    validateRange(args, sourceLines.length);

    const replacementLines = splitLines(Buffer.from(args.content));
    const updatedLines = [
      ...sourceLines.slice(0, args.startLine - 1),
      ...replacementLines,
      ...sourceLines.slice(args.endLine),
    ];
    const updated = joinLines(updatedLines, bytes[bytes.byteLength - 1] === NEWLINE);
    assertStillText(updated, args.path);

    let committed: { mtimeMs: number };
    try {
      committed = await writeRegularFileAtomic(resolvedPath, updated);
    } catch (error) {
      if (error instanceof RegularFileWriteError) throw new PathAccessError(error.message);
      throw error;
    }

    // A splice of the same height leaves every other line where it was; any
    // other one renumbers the file from startLine down.
    const replacedLines = args.endLine - args.startLine + 1;
    const sha256 = recordFileEdit(
      context.chatId,
      resolvedPath,
      updated,
      committed.mtimeMs,
      replacementLines.length === replacedLines ? Number.MAX_SAFE_INTEGER : args.startLine - 1
    );
    await recordFileMutationAfterHash(context, captured, sha256);
    return attachBeforeFields(
      {
        path: args.path,
        replacedLines,
        newTotalLines: countTotalLines(updated),
        sha256,
      },
      captured
    );
  });
}

/**
 * Refuses a splice whose result read_file would classify as binary. Writing a
 * NUL byte into a text file strands it: read_file then refuses it forever, and
 * every mutation tool gates on that read, so nothing could repair it again.
 */
function assertStillText(updated: Uint8Array, inputPath: string): void {
  if (!looksBinary(updated)) return;
  throw new ToolArgumentError(
    `Refusing to edit "${inputPath}": content contains a NUL byte, which would make the file ` +
      'unreadable by read_file and leave it unrecoverable by the file tools.'
  );
}

function validateRange(args: ReplaceRangeToolArgs, totalLines: number): void {
  if (
    !Number.isInteger(args.startLine) ||
    !Number.isInteger(args.endLine) ||
    args.startLine < 1 ||
    args.startLine > args.endLine ||
    args.endLine > totalLines
  ) {
    throw new ToolArgumentError(
      `Invalid line range ${args.startLine}-${args.endLine} for "${args.path}" ` +
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

/** Reassembles logical lines while preserving the source's final-newline state. */
function joinLines(lines: readonly Uint8Array[], trailingNewline: boolean): Uint8Array {
  // Deleting every logical line empties the file: with no lines left there is no
  // final newline to preserve, and the tool promises an empty range deletes it.
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

function execute(
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ReplaceRangeToolResult> {
  const path = getRequiredPathArg(args.path, 'path');
  const startLine = getRequiredInteger(args.startLine, 'startLine');
  const endLine = getRequiredInteger(args.endLine, 'endLine');
  const content = getRequiredTextArg(args.content, 'content');
  return executeReplaceRange({ path, startLine, endLine, content }, context);
}

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool({
    definition,
    settings: {
      title: 'Replace range',
      description: 'Allows the AI to replace inclusive line ranges in files read in this chat.',
      category: 'system',
      enabledByDefault: true,
      canDisable: true,
      defaultParameters: {
        allowedPaths: [],
        deniedPaths: [],
      },
      parameterDescriptors: pathPolicyParameterDescriptors(
        'List of paths where the tool may replace line ranges. Leave empty to allow all.',
        'List of paths where the tool may not replace line ranges. Leave empty to deny none.'
      ),
    },
    execute,
  });
}
