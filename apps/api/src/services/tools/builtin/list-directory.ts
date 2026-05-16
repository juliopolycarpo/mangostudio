/**
 * Built-in tool: list_directory
 * Lists files and directories at a given path.
 */

import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { registerTool } from '../registry';
import type { ToolContext } from '../types';
import {
  normalizePathList,
  PathAccessError,
  type PathValidationSettings,
  resolveAndValidatePath,
} from './_fs-utils';

export const LIST_DIRECTORY_TOOL_NAME = 'list_directory';

export interface ListDirectoryToolArgs {
  path: string;
}

export interface ListDirectoryEntry {
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
        description: 'Absolute directory path or path starting with ~ (home directory).',
      },
    },
    required: ['path'],
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
  const resolvedPath = resolveAndValidatePath(args.path, settings);

  let dirents: Dirent[];
  try {
    dirents = await readdir(resolvedPath, { withFileTypes: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list directory';
    throw new PathAccessError(`Cannot list "${args.path}": ${message}`);
  }

  return {
    path: args.path,
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
  const path = getRequiredString(args.path, 'path');
  return executeListDirectory({ path }, context);
}

/** Registers this tool. Called once at import time; can be re-called after clearRegistry(). */
export function register(): void {
  registerTool({
    definition,
    settings: {
      title: 'List directory',
      description: 'Allows the AI to list files and directories on disk.',
      category: 'system',
      enabledByDefault: false,
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

function getRequiredString(value: unknown, name: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new PathAccessError(`Missing required ${name}.`);
  return text;
}

// Self-register on import
register();
