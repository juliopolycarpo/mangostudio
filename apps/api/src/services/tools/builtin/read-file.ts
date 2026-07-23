/**
 * Built-in tool: read_file
 * Reads the contents of a text file from disk.
 */

import { recordFileRead } from '../file-freshness';
import { registerTool } from '../registry';
import type { ToolContext } from '../types';
import {
  getRequiredPathArg,
  normalizePathList,
  type PathValidationSettings,
  readFileWithObservedMtime,
  resolveAndValidatePath,
} from './_fs-utils';

const READ_FILE_TOOL_NAME = 'read_file';

export interface ReadFileToolArgs {
  path: string;
}

export interface ReadFileToolResult {
  content: string;
  path: string;
  size: number;
  sha256: string;
}

export type ReadFileToolSettings = PathValidationSettings;

const definition = {
  name: READ_FILE_TOOL_NAME,
  description:
    'Reads the contents of a file from disk. Use this when the user asks to inspect, view, or read a file.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path, ~ path, or path relative to the chat working directory.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
};

export function normalizeReadFileToolSettings(
  parameters: Record<string, unknown>
): ReadFileToolSettings {
  return {
    allowedPaths: normalizePathList(parameters.allowedPaths),
    deniedPaths: normalizePathList(parameters.deniedPaths),
  };
}

export async function executeReadFile(
  args: ReadFileToolArgs,
  context: ToolContext
): Promise<ReadFileToolResult> {
  const settings = normalizeReadFileToolSettings(context.parameters);
  const resolvedPath = resolveAndValidatePath(args.path, {
    settings,
    workdir: context.workdir,
    workdirPolicy: context.workdirPolicy,
  });

  const { bytes, mtimeMs } = await readFileWithObservedMtime(resolvedPath);
  const content = new TextDecoder().decode(bytes);
  const sha256 = recordFileRead(context.chatId, resolvedPath, bytes, mtimeMs);

  return { content, path: args.path, size: bytes.byteLength, sha256 };
}

// biome-ignore lint/suspicious/useAwait: Migrated from ESLint
async function execute(
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ReadFileToolResult> {
  const path = getRequiredPathArg(args.path, 'path');
  return executeReadFile({ path }, context);
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
      parameterDescriptors: [
        {
          name: 'allowedPaths',
          label: 'Allowed paths',
          description: 'List of paths the tool is allowed to access. Leave empty to allow all.',
          type: 'path_list',
          required: false,
          defaultValue: [] as Array<{ path: string; enabled: boolean }>,
        },
        {
          name: 'deniedPaths',
          label: 'Denied paths',
          description: 'List of paths the tool is denied from accessing. Leave empty to deny none.',
          type: 'path_list',
          required: false,
          defaultValue: [] as Array<{ path: string; enabled: boolean }>,
        },
      ],
    },
    execute,
  });
}
