/**
 * Built-in tool: delete_file
 * Deletes a regular file after confirming the chat has read its current contents.
 */

import { unlink } from 'node:fs/promises';
import {
  assertFresh,
  FileNotReadError,
  forgetFile,
  StaleFileError,
  withPathLocks,
} from '../file-freshness';
import { registerTool } from '../registry';
import type { ToolContext } from '../types';
import {
  assertRegularFilePath,
  getRequiredPathArg,
  isErrnoException,
  isProbablyBinaryFile,
  normalizePathValidationSettings,
  PathAccessError,
  type PathValidationSettings,
  pathPolicyParameterDescriptors,
  resolveAndValidatePath,
} from './_fs-utils';
import { READ_FILE_MAX_BYTES } from './read-file';

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
  return normalizePathValidationSettings(parameters);
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
    const entry = await assertRegularFilePath(resolvedPath, 'delete');

    try {
      await assertFresh(context.chatId, resolvedPath);
    } catch (error) {
      if (error instanceof FileNotReadError) {
        throw await explainUnreadableFile(resolvedPath, entry.size, error);
      }
      throw error;
    }

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

/**
 * "Read it first" is the right remediation for a text file the model simply has
 * not opened yet, but read_file refuses binary and oversized files outright, so
 * handing that advice to the model for one sends it into a retry loop with no
 * exit. Name the real blocker instead.
 */
async function explainUnreadableFile(
  resolvedPath: string,
  sizeBytes: number,
  unreadError: Error
): Promise<Error> {
  if (sizeBytes > READ_FILE_MAX_BYTES) {
    return new PathAccessError(
      `Cannot delete "${resolvedPath}": it is ${sizeBytes} bytes, past the ${READ_FILE_MAX_BYTES}-byte ` +
        'read_file limit, so the read-before-delete guard cannot be satisfied for this path.'
    );
  }
  if (await isProbablyBinaryFile(resolvedPath)) {
    return new PathAccessError(
      `Cannot delete "${resolvedPath}": it is a binary file. read_file cannot read binary files, ` +
        'so the read-before-delete guard cannot be satisfied for this path.'
    );
  }
  return unreadError;
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
      parameterDescriptors: pathPolicyParameterDescriptors(
        'List of paths where the tool is allowed to delete files. Leave empty to allow all.',
        'List of paths where the tool is denied from deleting files. Leave empty to deny none.'
      ),
    },
    execute,
  });
}
