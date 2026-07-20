/**
 * Built-in tool: list_directory
 * Lists files and directories at a given path.
 */

import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { getOptionalString } from '../arg-parsing';
import { registerTool } from '../registry';
import type { ToolContext } from '../types';
import {
  getRequiredPathArg,
  normalizePathList,
  PathAccessError,
  type PathValidationSettings,
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
          'Optional directory path. Defaults to the chat working directory when available.',
      },
    },
    additionalProperties: false,
  },
};

export function normalizeListDirectoryToolSettings(
  parameters: Record<string, unknown>
): ListDirectoryToolSettings {
  return {
    allowedPaths: normalizePathList(parameters.allowedPaths),
    deniedPaths: normalizePathList(parameters.deniedPaths),
  };
}

export async function executeListDirectory(
  args: ListDirectoryToolArgs,
  context: ToolContext
): Promise<ListDirectoryToolResult> {
  const settings = normalizeListDirectoryToolSettings(context.parameters);
  const path = getRequiredPathArg(args.path ?? context.workdir, 'path');
  const resolvedPath = resolveAndValidatePath(path, settings, context.workdirPolicy);

  let dirents: Dirent[];
  try {
    dirents = await readdir(resolvedPath, { withFileTypes: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list directory';
    throw new PathAccessError(`Cannot list "${path}": ${message}`);
  }

  return {
    path,
    entries: dirents.map((entry) => ({
      name: String(entry.name),
      type: entry.isDirectory() ? 'directory' : 'file',
    })),
  };
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
