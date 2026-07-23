/**
 * Built-in tool: replace_range
 * Replaces an inclusive range of lines in an existing file.
 */

import { RegularFileWriteError, writeRegularFileAtomic } from '../../../lib/safe-file';
import { getRequiredTextArg, ToolArgumentError } from '../arg-parsing';
import { assertFresh, recordFileRead, withPathLocks } from '../file-freshness';
import { registerTool } from '../registry';
import type { ToolContext } from '../types';
import {
  getRequiredPathArg,
  normalizePathValidationSettings,
  PathAccessError,
  type PathValidationSettings,
  pathPolicyParameterDescriptors,
  readFileWithObservedMtime,
  resolveAndValidatePath,
} from './_fs-utils';
import { countTotalLines } from './read-file';

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
}

export type ReplaceRangeToolSettings = PathValidationSettings;

const definition = {
  name: REPLACE_RANGE_TOOL_NAME,
  description:
    'Replaces a 1-indexed inclusive line range in an existing text file. Line numbers refer ' +
    'to the file as last read with read_file. The file must be read completely first. If the ' +
    'file is stale, re-read it before retrying. The replacement may contain any number of lines ' +
    'or be empty to delete the range.',
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
    await assertFresh(context.chatId, resolvedPath);
    const { bytes } = await readFileWithObservedMtime(resolvedPath);
    const totalLines = countTotalLines(bytes);
    validateRange(args, totalLines);

    const sourceLines = splitLines(bytes);
    const replacementLines = splitLines(Buffer.from(args.content));
    const updatedLines = [
      ...sourceLines.slice(0, args.startLine - 1),
      ...replacementLines,
      ...sourceLines.slice(args.endLine),
    ];
    const updated = joinLines(updatedLines, bytes[bytes.byteLength - 1] === NEWLINE);

    let committed: { mtimeMs: number };
    try {
      committed = await writeRegularFileAtomic(resolvedPath, updated);
    } catch (error) {
      if (error instanceof RegularFileWriteError) throw new PathAccessError(error.message);
      throw error;
    }

    const sha256 = recordFileRead(context.chatId, resolvedPath, updated, committed.mtimeMs);
    return {
      path: args.path,
      replacedLines: args.endLine - args.startLine + 1,
      newTotalLines: countTotalLines(updated),
      sha256,
    };
  });
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
  // Deleting every logical line from a newline-terminated file leaves its
  // terminator intact, preserving the source's final-newline state exactly.
  if (lines.length === 0 && trailingNewline) joined[0] = NEWLINE;
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

function getRequiredInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ToolArgumentError(`Field "${name}" must be an integer.`);
  }
  return value;
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
