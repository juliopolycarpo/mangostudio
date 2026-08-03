/**
 * Built-in tool: create_file
 * Creates a new text file without overwriting an existing path.
 */

import { getRuntimeClient } from '../../runtime-client';
import { getRequiredTextArg } from '../arg-parsing';
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
  const runtime = await getRuntimeClient(context.userId, context.environmentId);
  const options = {
    settings,
    workdir: context.workdir,
    workdirPolicy: context.workdirPolicy,
    paths: runtime.paths,
  };
  const resolvedPath = resolveAndValidatePath(args.path, options);

  const { result, mutations } = await runtime.fs.createFile(
    {
      chatId: context.chatId,
      inputPath: args.path,
      resolvedPath,
      content: args.content,
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
      requiredCapabilities: ['fsWrite'],
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
