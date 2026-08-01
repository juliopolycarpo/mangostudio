/**
 * Built-in tool: read_file
 * Reads the contents of a text file from disk with line numbers and windowing.
 */

import {
  countTotalLines,
  findWindowByteRange,
  looksBinary,
  READ_FILE_MAX_LINE_CHARS,
  READ_FILE_MAX_MAX_LINES,
  READ_FILE_MAX_START_LINE,
  READ_FILE_MAX_WINDOW_BYTES,
  READ_FILE_MIN_MAX_LINES,
} from '@mangostudio/runtime';
import { getRuntimeClient } from '../../runtime-client';
import { getBoundedOptionalInteger } from '../arg-parsing';
import { registerTool } from '../registry';
import type { ToolContext } from '../types';
import {
  getRequiredPathArg,
  normalizePathValidationSettings,
  type PathValidationSettings,
  pathPolicyParameterDescriptors,
  resolveAndValidatePath,
  runtimePathPolicy,
} from './_fs-utils';

const READ_FILE_TOOL_NAME = 'read_file';

export {
  countTotalLines,
  findWindowByteRange,
  looksBinary,
  READ_FILE_MAX_LINE_CHARS,
  READ_FILE_MAX_MAX_LINES,
  READ_FILE_MAX_START_LINE,
  READ_FILE_MAX_WINDOW_BYTES,
  READ_FILE_MIN_MAX_LINES,
};

const READ_FILE_DEFAULT_START_LINE = 1;
const READ_FILE_DEFAULT_MAX_LINES = 2000;

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
  return normalizePathValidationSettings(parameters);
}

export async function executeReadFile(
  args: ReadFileToolArgs,
  context: ToolContext
): Promise<ReadFileToolResult> {
  const settings = normalizeReadFileToolSettings(context.parameters);
  // The runtime comes first because its manifest says how paths resolve on the
  // target: `~` is its home directory, and its separator joins relative input.
  const runtime = await getRuntimeClient(context.userId, context.environmentId);
  const options = {
    settings,
    workdir: context.workdir,
    workdirPolicy: context.workdirPolicy,
    paths: runtime.paths,
  };
  const resolvedPath = resolveAndValidatePath(args.path, options);

  const startLine = args.startLine ?? READ_FILE_DEFAULT_START_LINE;
  const maxLines = args.maxLines ?? READ_FILE_DEFAULT_MAX_LINES;

  return await runtime.fs.readFile(
    {
      chatId: context.chatId,
      inputPath: args.path,
      resolvedPath,
      startLine,
      maxLines,
      ...runtimePathPolicy(options),
    },
    { signal: context.signal }
  );
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
      parameterDescriptors: pathPolicyParameterDescriptors(
        'List of paths the tool is allowed to access. Leave empty to allow all.',
        'List of paths the tool is denied from accessing. Leave empty to deny none.'
      ),
    },
    execute,
  });
}
