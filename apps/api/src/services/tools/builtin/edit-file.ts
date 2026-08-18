/**
 * Built-in tool: edit_file
 * Replaces exact text in an existing file without rewriting it from model output.
 */

import { getRuntimeClient } from '../../runtime-client';
import { getOptionalBoolean, getRequiredTextArg } from '../arg-parsing';
import { withMutationPersistence } from '../file-mutation-snapshot';
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

const EDIT_FILE_TOOL_NAME = 'edit_file';

export interface EditFileToolArgs {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export interface EditFileToolResult {
  path: string;
  replacements: number;
  sha256: string;
  firstChangedLine: number;
}

export type EditFileToolSettings = PathValidationSettings;

const definition = {
  name: EDIT_FILE_TOOL_NAME,
  description:
    'Replaces exact text in an existing text file. The file must be read completely with ' +
    'read_file first. oldString must match exactly, including whitespace and line endings. ' +
    'It must occur at least once and be unique by default; set replaceAll to true to replace ' +
    'every non-overlapping occurrence.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path, ~ path, or path relative to the chat working directory.',
      },
      oldString: {
        type: 'string',
        description: 'Exact text to replace, including whitespace and line endings.',
      },
      newString: {
        type: 'string',
        description: 'Exact replacement text. May be empty to delete the matched text.',
      },
      replaceAll: {
        type: 'boolean',
        description:
          'Replace every occurrence instead of requiring one unique match. Omit, pass null, or false to require a unique match.',
      },
    },
    required: ['path', 'oldString', 'newString'],
    additionalProperties: false,
  },
};

export function normalizeEditFileToolSettings(
  parameters: Record<string, unknown>
): EditFileToolSettings {
  return normalizePathValidationSettings(parameters);
}

export async function executeEditFile(
  args: EditFileToolArgs,
  context: ToolContext
): Promise<EditFileToolResult> {
  const settings = normalizeEditFileToolSettings(context.parameters);
  const runtime = await getRuntimeClient(context.userId, context.environmentId);
  const options = {
    settings,
    workdir: context.workdir,
    workdirPolicy: context.workdirPolicy,
    paths: runtime.paths,
  };
  const resolvedPath = resolveAndValidatePath(args.path, options);

  const { result } = await withMutationPersistence(context, [resolvedPath], () =>
    runtime.fs.editFile(
      {
        chatId: context.chatId,
        inputPath: args.path,
        resolvedPath,
        oldString: args.oldString,
        newString: args.newString,
        ...(args.replaceAll !== undefined ? { replaceAll: args.replaceAll } : {}),
        captureSnapshot: Boolean(context.assistantMessageId),
        ...runtimePathPolicy(options),
      },
      context.signal ? { signal: context.signal } : undefined
    )
  );
  return result;
}

function execute(args: Record<string, unknown>, context: ToolContext): Promise<EditFileToolResult> {
  const path = getRequiredPathArg(args.path, 'path');
  const oldString = getRequiredTextArg(args.oldString, 'oldString');
  const newString = getRequiredTextArg(args.newString, 'newString');
  const replaceAll = getOptionalBoolean(args.replaceAll, 'replaceAll');
  return executeEditFile(
    { path, oldString, newString, ...(replaceAll !== undefined ? { replaceAll } : {}) },
    context
  );
}

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool({
    definition,
    settings: {
      title: 'Edit file',
      description: 'Allows the AI to replace exact text in files it has read in this chat.',
      category: 'system',
      enabledByDefault: true,
      canDisable: true,
      requiredCapabilities: ['fsWrite'],
      defaultParameters: {
        allowedPaths: [],
        deniedPaths: [],
      },
      parameterDescriptors: pathPolicyParameterDescriptors(
        'List of paths where the tool is allowed to edit files. Leave empty to allow all.',
        'List of paths where the tool is denied from editing files. Leave empty to deny none.'
      ),
    },
    execute,
  });
}
