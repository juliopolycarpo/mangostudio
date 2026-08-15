/**
 * Built-in tool: write_file
 * Writes text content to a file on disk, creating parent directories as needed.
 */

import { getRuntimeClient } from '../../runtime-client';
import { getRequiredTextArg } from '../arg-parsing';
import {
  attachBeforeFields,
  type BeforeOmittedReason,
  withMutationPersistence,
} from '../file-mutation-snapshot';
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

const WRITE_FILE_TOOL_NAME = 'write_file';

export interface WriteFileToolArgs {
  path: string;
  content: string;
}

export interface WriteFileToolResult {
  path: string;
  bytesWritten: number;
  created: boolean;
  sha256: string;
  before?: string;
  beforeOmitted?: BeforeOmittedReason;
}

export type WriteFileToolSettings = PathValidationSettings;

const definition = {
  name: WRITE_FILE_TOOL_NAME,
  description:
    'Writes text content to a file on disk. Creates parent directories if they do not exist. ' +
    'Overwriting an existing file requires reading all of it with read_file first, and replaces ' +
    'every line: prefer edit_file for an exact text change or replace_range for a line change. ' +
    'Use this when the user asks to create, write, or save a whole file.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path, ~ path, or path relative to the chat working directory.',
      },
      content: {
        type: 'string',
        description: 'The text content to write to the file.',
      },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
};

export function normalizeWriteFileToolSettings(
  parameters: Record<string, unknown>
): WriteFileToolSettings {
  return normalizePathValidationSettings(parameters);
}

export async function executeWriteFile(
  args: WriteFileToolArgs,
  context: ToolContext
): Promise<WriteFileToolResult> {
  const settings = normalizeWriteFileToolSettings(context.parameters);
  const runtime = await getRuntimeClient(context.userId, context.environmentId);
  const options = {
    settings,
    workdir: context.workdir,
    workdirPolicy: context.workdirPolicy,
    paths: runtime.paths,
  };
  const resolvedPath = resolveAndValidatePath(args.path, options);

  const { result, captured } = await withMutationPersistence(context, [resolvedPath], () =>
    runtime.fs.writeFile(
      {
        chatId: context.chatId,
        inputPath: args.path,
        resolvedPath,
        content: args.content,
        captureSnapshot: Boolean(context.assistantMessageId),
        ...runtimePathPolicy(options),
      },
      context.signal ? { signal: context.signal } : undefined
    )
  );
  return attachBeforeFields(result, captured[0]);
}

function execute(
  args: Record<string, unknown>,
  context: ToolContext
): Promise<WriteFileToolResult> {
  const path = getRequiredPathArg(args.path, 'path');
  const content = getRequiredTextArg(args.content, 'content');
  return executeWriteFile({ path, content }, context);
}

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool({
    definition,
    settings: {
      title: 'Write file',
      description:
        'Allows the AI to create text files and overwrite files it has read in this chat.',
      category: 'system',
      enabledByDefault: true,
      canDisable: true,
      requiredCapabilities: ['fsWrite'],
      defaultParameters: {
        allowedPaths: [],
        deniedPaths: [],
      },
      parameterDescriptors: pathPolicyParameterDescriptors(
        'List of paths the tool is allowed to write to. Leave empty to allow all.',
        'List of paths the tool is denied from writing to. Leave empty to deny none.'
      ),
    },
    execute,
  });
}
