/**
 * Built-in tool: create_file
 * Creates a new text file without overwriting an existing path.
 */

import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RegularFileWriteError, writeRegularFileAtomic } from '../../../lib/safe-file';
import { getRequiredTextArg } from '../arg-parsing';
import { recordFileRead, withPathLocks } from '../file-freshness';
import {
  attachBeforeFields,
  ensureFileMutationCheckpoint,
  recordFileMutationAfterHash,
} from '../file-mutation-snapshot';
import { registerTool } from '../registry';
import type { ToolContext } from '../types';
import {
  getRequiredPathArg,
  isErrnoException,
  normalizePathValidationSettings,
  PathAccessError,
  type PathValidationSettings,
  pathPolicyParameterDescriptors,
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
    'path already exists and never overwrites it. After reading an existing file, use ' +
    'edit_file for exact text changes, replace_range for line changes, or write_file to replace it.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path, ~ path, or path relative to the chat working directory.',
      },
      content: {
        type: 'string',
        description: 'The exact text content for the new file. May be empty.',
      },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
};

export function normalizeCreateFileToolSettings(
  parameters: Record<string, unknown>
): CreateFileToolSettings {
  return normalizePathValidationSettings(parameters);
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
    const captured = await ensureFileMutationCheckpoint(context, resolvedPath, 'create');
    let committed: { bytesWritten: number; mtimeMs: number };
    try {
      committed = await writeRegularFileAtomic(resolvedPath, args.content, { exclusive: true });
    } catch (error) {
      // The destination policy is the tool's own remediation advice, not a
      // filesystem failure, so it reaches the model as a path error.
      if (error instanceof RegularFileWriteError) throw new PathAccessError(error.message);
      if (isErrnoException(error, 'EEXIST')) {
        throw await describeBlockedCreate(resolvedPath, args.path);
      }
      throw error;
    }

    const sha256 = recordFileRead(context.chatId, resolvedPath, args.content, committed.mtimeMs);
    await recordFileMutationAfterHash(context, resolvedPath, sha256);
    return attachBeforeFields(
      { path: args.path, bytesWritten: committed.bytesWritten, sha256 },
      captured
    );
  });
}

/**
 * EEXIST reaches this tool from two places: the destination itself is taken, or
 * a parent component of it is a regular file, which fails the recursive mkdir.
 * Naming the wrong one sends the model to write_file for a path that does not
 * exist and can never be created under that parent.
 */
async function describeBlockedCreate(resolvedPath: string, inputPath: string): Promise<Error> {
  const exists = await lstat(resolvedPath).then(
    () => true,
    () => false
  );
  if (exists) {
    return new PathAccessError(
      `"${inputPath}" already exists. Read it with read_file, then use edit_file for an exact ` +
        'text change, replace_range for a line change, or write_file to replace all content.'
    );
  }
  return new PathAccessError(
    `Cannot create "${inputPath}": "${dirname(resolvedPath)}" is not a directory.`
  );
}

function execute(
  args: Record<string, unknown>,
  context: ToolContext
): Promise<CreateFileToolResult> {
  const path = getRequiredPathArg(args.path, 'path');
  const content = getRequiredTextArg(args.content, 'content');
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
      parameterDescriptors: pathPolicyParameterDescriptors(
        'List of paths where the tool is allowed to create files. Leave empty to allow all.',
        'List of paths where the tool is denied from creating files. Leave empty to deny none.'
      ),
    },
    execute,
  });
}
