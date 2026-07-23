/**
 * Built-in tool: create_file
 * Creates a new text file without overwriting an existing path.
 */

import { RegularFileWriteError, writeRegularFileAtomic } from '../../../lib/safe-file';
import { getRequiredString } from '../arg-parsing';
import { recordFileRead, withPathLocks } from '../file-freshness';
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

const CREATE_FILE_TOOL_NAME = 'create_file';

export interface CreateFileToolArgs {
  path: string;
  content: string;
}

export interface CreateFileToolResult {
  path: string;
  bytesWritten: number;
  sha256: string;
}

export type CreateFileToolSettings = PathValidationSettings;

const definition = {
  name: CREATE_FILE_TOOL_NAME,
  description:
    'Creates a new text file on disk, including missing parent directories. Fails if the ' +
    'path already exists and never overwrites it. Use write_file to replace a file after ' +
    'reading it, or edit_file to modify part of a file.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path, ~ path, or path relative to the chat working directory.',
      },
      content: {
        type: 'string',
        description: 'The text content for the new file.',
      },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
};

export function normalizeCreateFileToolSettings(
  parameters: Record<string, unknown>
): CreateFileToolSettings {
  return {
    allowedPaths: normalizePathList(parameters.allowedPaths),
    deniedPaths: normalizePathList(parameters.deniedPaths),
  };
}

export async function executeCreateFile(
  args: CreateFileToolArgs,
  context: ToolContext
): Promise<CreateFileToolResult> {
  const settings = normalizeCreateFileToolSettings(context.parameters);
  const resolvedPath = resolveAndValidatePath(args.path, {
    settings,
    workdir: context.workdir,
    workdirPolicy: context.workdirPolicy,
  });

  return await withPathLocks([resolvedPath], async () => {
    let committed: { bytesWritten: number; mtimeMs: number };
    try {
      committed = await writeRegularFileAtomic(resolvedPath, args.content, { exclusive: true });
    } catch (error) {
      if (isErrnoException(error, 'EEXIST') || error instanceof RegularFileWriteError) {
        throw new PathAccessError(
          `"${args.path}" already exists. Use write_file to overwrite it or edit_file to modify it.`
        );
      }
      throw error;
    }

    const sha256 = recordFileRead(context.chatId, resolvedPath, args.content, committed.mtimeMs);
    return { path: args.path, bytesWritten: committed.bytesWritten, sha256 };
  });
}

function execute(
  args: Record<string, unknown>,
  context: ToolContext
): Promise<CreateFileToolResult> {
  const path = getRequiredPathArg(args.path, 'path');
  const content = getRequiredString(args.content, 'content');
  return executeCreateFile({ path, content }, context);
}

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool({
    definition,
    settings: {
      title: 'Create file',
      description: 'Allows the AI to create new text files without overwriting existing paths.',
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
            'List of paths where the tool is allowed to create files. Leave empty to allow all.',
          type: 'path_list',
          required: false,
          defaultValue: [] as Array<{ path: string; enabled: boolean }>,
        },
        {
          name: 'deniedPaths',
          label: 'Denied paths',
          description:
            'List of paths where the tool is denied from creating files. Leave empty to deny none.',
          type: 'path_list',
          required: false,
          defaultValue: [] as Array<{ path: string; enabled: boolean }>,
        },
      ],
    },
    execute,
  });
}
