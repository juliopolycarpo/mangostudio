/**
 * Built-in tool: read_file
 * Reads the contents of a text file from disk with line numbers and windowing.
 */

import {
  countTotalLines,
  findWindowByteRange,
  looksBinary,
  READ_FILE_MAX_BINARY_VIEW_BYTES,
  READ_FILE_MAX_LINE_CHARS,
  READ_FILE_MAX_MAX_LINES,
  READ_FILE_MAX_START_LINE,
  READ_FILE_MAX_WINDOW_BYTES,
  READ_FILE_MIN_MAX_LINES,
  RUNTIME_READ_FILE_VIEWS,
  type RuntimeReadFileView,
} from '@mangostudio/runtime';
import { getRuntimeClient } from '../../runtime-client';
import { getBoundedOptionalInteger, getOptionalEnum, ToolArgumentError } from '../arg-parsing';
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
  READ_FILE_MAX_BINARY_VIEW_BYTES,
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
  view?: RuntimeReadFileView;
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
  view?: Exclude<RuntimeReadFileView, 'text'>;
}

export type ReadFileToolSettings = PathValidationSettings;

const definition = {
  name: READ_FILE_TOOL_NAME,
  description:
    'Reads the contents of a file from disk. Output is line-numbered (cat -n style); ' +
    'the line numbers are a reading aid and are not part of the file content. Use ' +
    'startLine/maxLines to window large files instead of reading everything at once. Use ' +
    'this when the user asks to inspect, view, or read a file. A binary file cannot be read ' +
    'as text: pass view "hex" or "base64" to read its bytes, which also satisfies the ' +
    'read-before-write guard so the file can then be overwritten. A byte view does not ' +
    'assign line numbers; replace_range still needs a text read first.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path, ~ path, or path relative to the chat working directory.',
      },
      startLine: {
        type: ['integer', 'null'],
        description:
          '1-based line to start reading from. Pass null to start at line 1. Applies to view "text" only.',
        minimum: 1,
      },
      maxLines: {
        type: ['integer', 'null'],
        description: `Maximum number of lines to return (max ${READ_FILE_MAX_MAX_LINES}). Pass null for the default of ${READ_FILE_DEFAULT_MAX_LINES}. Applies to view "text" only.`,
        minimum: READ_FILE_MIN_MAX_LINES,
        maximum: READ_FILE_MAX_MAX_LINES,
      },
      view: {
        type: ['string', 'null'],
        enum: [...RUNTIME_READ_FILE_VIEWS, null],
        description:
          'How to render the file\'s bytes. "text" decodes as UTF-8 and refuses binary files; ' +
          `"hex" and "base64" return the raw bytes of any file up to ${READ_FILE_MAX_BINARY_VIEW_BYTES} ` +
          'bytes, unwindowed. Pass null for "text".',
      },
    },
    required: ['path', 'startLine', 'maxLines', 'view'],
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

  const view = args.view ?? 'text';
  // A byte view has no lines to window, so a line range asked for alongside one
  // could only be dropped. Answering a request the tool cannot honour is the
  // failure mode strict argument handling exists to remove: the model reads a
  // full dump as the slice it asked for.
  if (view !== 'text' && (args.startLine !== undefined || args.maxLines !== undefined)) {
    throw new ToolArgumentError(
      `Fields "startLine" and "maxLines" apply to view "text" only; view "${view}" returns the whole file.`
    );
  }
  const startLine = args.startLine ?? READ_FILE_DEFAULT_START_LINE;
  const maxLines = args.maxLines ?? READ_FILE_DEFAULT_MAX_LINES;

  return await runtime.fs.readFile(
    {
      chatId: context.chatId,
      inputPath: args.path,
      resolvedPath,
      startLine,
      maxLines,
      ...(view === 'text' ? {} : { view }),
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
  const view = getOptionalEnum(args.view, 'view', RUNTIME_READ_FILE_VIEWS) ?? 'text';

  return executeReadFile(
    {
      path,
      ...(startLine !== undefined ? { startLine } : {}),
      ...(maxLines !== undefined ? { maxLines } : {}),
      view,
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
      description: 'Allows the AI to read files from disk, as text or as raw bytes.',
      category: 'system',
      enabledByDefault: true,
      canDisable: true,
      requiredCapabilities: ['fsRead'],
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
