/**
 * Built-in tool: delete_file
 * Deletes a regular file after confirming the chat has read its current contents.
 */

import { lstat, unlink } from 'node:fs/promises';
import { assertFresh, forgetFile, StaleFileError, withPathLocks } from '../file-freshness';
import { registerTool } from '../registry';
import type { ToolContext } from '../types';
import {
  getRequiredPathArg,
  isErrnoException,
  normalizePathList,
  PathAccessError,
  type PathValidationSettings,
  resolveAndValidatePath,
} from './_fs-utils';

const DELETE_FILE_TOOL_NAME = 'delete_file';

export interface DeleteFileToolArgs {
  path: string;
}

export interface DeleteFileToolResult {
  path: string;
  deleted: true;
}

export type DeleteFileToolSettings = PathValidationSettings;

const definition = {
  name: DELETE_FILE_TOOL_NAME,
  description:
    'Deletes a regular file from disk. The current file must first be read in full with ' +
    'read_file, and deletion fails if its contents changed after that read. Directories and ' +
    'symbolic links are never deleted.',
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

export function normalizeDeleteFileToolSettings(
  parameters: Record<string, unknown>
): DeleteFileToolSettings {
  return {
    allowedPaths: normalizePathList(parameters.allowedPaths),
    deniedPaths: normalizePathList(parameters.deniedPaths),
  };
}

export async function executeDeleteFile(
  args: DeleteFileToolArgs,
  context: ToolContext
): Promise<DeleteFileToolResult> {
  const settings = normalizeDeleteFileToolSettings(context.parameters);
  const resolvedPath = resolveAndValidatePath(args.path, {
    settings,
    workdir: context.workdir,
    workdirPolicy: context.workdirPolicy,
  });

  return await withPathLocks([resolvedPath], async () => {
    await assertRegularFile(resolvedPath);
    await assertFresh(context.chatId, resolvedPath);

    try {
      await unlink(resolvedPath);
    } catch (error) {
      if (isErrnoException(error, 'ENOENT')) throw new StaleFileError(resolvedPath);
      throw error;
    }

    forgetFile(context.chatId, resolvedPath);
    return { path: args.path, deleted: true };
  });
}

async function assertRegularFile(resolvedPath: string): Promise<void> {
  const entry = await lstat(resolvedPath).catch((error: unknown) => {
    if (isErrnoException(error, 'ENOENT')) {
      throw new PathAccessError(`File not found: "${resolvedPath}"`);
    }
    throw error;
  });
  if (!entry.isFile()) {
    throw new PathAccessError(
      `Cannot delete "${resolvedPath}": it is not a regular file. Directories and symbolic links are not supported.`
    );
  }
}

function execute(
  args: Record<string, unknown>,
  context: ToolContext
): Promise<DeleteFileToolResult> {
  const path = getRequiredPathArg(args.path, 'path');
  return executeDeleteFile({ path }, context);
}

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool({
    definition,
    settings: {
      title: 'Delete file',
      description: 'Allows the AI to delete regular files it has read in this chat.',
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
          description:
            'List of paths where the tool is allowed to delete files. Leave empty to allow all.',
          type: 'path_list',
          required: false,
          defaultValue: [] as Array<{ path: string; enabled: boolean }>,
        },
        {
          name: 'deniedPaths',
          label: 'Denied paths',
          description:
            'List of paths where the tool is denied from deleting files. Leave empty to deny none.',
          type: 'path_list',
          required: false,
          defaultValue: [] as Array<{ path: string; enabled: boolean }>,
        },
      ],
    },
    execute,
  });
}
