/**
 * Built-in tool: delete_file
 * Deletes a regular file after confirming the chat has read its current contents.
 */

import { getRuntimeClient } from '../../runtime-client';
import { persistRuntimeMutations } from '../file-mutation-snapshot';
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
  const runtime = await getRuntimeClient(context.userId, context.environmentId);
  const options = {
    settings,
    workdir: context.workdir,
    workdirPolicy: context.workdirPolicy,
    paths: runtime.paths,
  };
  const resolvedPath = resolveAndValidatePath(args.path, options);

  const { result, mutations } = await runtime.fs.deleteFile(
    {
      chatId: context.chatId,
      inputPath: args.path,
      resolvedPath,
      captureSnapshot: Boolean(context.assistantMessageId),
      ...runtimePathPolicy(options),
    },
    context.signal ? { signal: context.signal } : undefined
  );
  await persistRuntimeMutations(context, mutations);
  return result;
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
