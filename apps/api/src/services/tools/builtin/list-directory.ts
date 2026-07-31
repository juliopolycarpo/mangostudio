/**
 * Built-in tool: list_directory
 * Lists files and directories at a given path.
 */

import { getRuntimeClient } from '../../runtime-client';
import { getOptionalString } from '../arg-parsing';
import { registerTool } from '../registry';
import type { ToolContext } from '../types';
import {
  getRequiredPathArg,
  normalizePathValidationSettings,
  type PathValidationSettings,
  pathPolicyParameterDescriptors,
  resolveAndValidatePath,
} from './_fs-utils';

const LIST_DIRECTORY_TOOL_NAME = 'list_directory';

export interface ListDirectoryToolArgs {
  path?: string;
}

interface ListDirectoryEntry {
  name: string;
  type: 'file' | 'directory';
}

export interface ListDirectoryToolResult {
  path: string;
  entries: ListDirectoryEntry[];
}

export type ListDirectoryToolSettings = PathValidationSettings;

const definition = {
  name: LIST_DIRECTORY_TOOL_NAME,
  description:
    'Lists files and directories at a given path. Use this when the user asks to explore, browse, or see what is inside a folder.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Optional absolute path, ~ path, or path relative to the chat working directory. Defaults to the chat working directory when available.',
      },
    },
    additionalProperties: false,
  },
};

export function normalizeListDirectoryToolSettings(
  parameters: Record<string, unknown>
): ListDirectoryToolSettings {
  return normalizePathValidationSettings(parameters);
}

export async function executeListDirectory(
  args: ListDirectoryToolArgs,
  context: ToolContext
): Promise<ListDirectoryToolResult> {
  const settings = normalizeListDirectoryToolSettings(context.parameters);
  const path = getRequiredPathArg(args.path ?? context.workdir, 'path');
  const resolvedPath = resolveAndValidatePath(path, {
    settings,
    workdir: context.workdir,
    workdirPolicy: context.workdirPolicy,
  });

  const runtime = await getRuntimeClient();
  const result = await runtime.fs.listDirectory(
    { inputPath: path, resolvedPath },
    context.signal ? { signal: context.signal } : undefined
  );
  return { ...result, entries: [...result.entries] };
}

// biome-ignore lint/suspicious/useAwait: Migrated from ESLint
async function execute(
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ListDirectoryToolResult> {
  const path = getOptionalString(args.path);
  return executeListDirectory({ ...(path ? { path } : {}) }, context);
}

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool({
    definition,
    settings: {
      title: 'List directory',
      description: 'Allows the AI to list files and directories on disk.',
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
