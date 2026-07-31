/**
 * Built-in tool: move_file
 * Moves or renames a regular file without overwriting the destination.
 */

import { getRuntimeClient } from '../../runtime-client';
import { persistRuntimeMutations } from '../file-mutation-snapshot';
import { registerTool } from '../registry';
import type { ToolContext } from '../types';
import {
  getRequiredPathArg,
  normalizePathValidationSettings,
  PathAccessError,
  type PathValidationSettings,
  pathPolicyParameterDescriptors,
  resolveAndValidatePath,
} from './_fs-utils';

const MOVE_FILE_TOOL_NAME = 'move_file';

export interface MoveFileToolArgs {
  from: string;
  to: string;
}

export interface MoveFileToolResult {
  from: string;
  to: string;
  moved: true;
}

export type MoveFileToolSettings = PathValidationSettings;

const definition = {
  name: MOVE_FILE_TOOL_NAME,
  description:
    'Moves or renames a regular file, including across filesystems. Both paths must be ' +
    'allowed, missing destination directories are created, and an existing destination is ' +
    'never overwritten. The source does not need to be read first.',
  parameters: {
    type: 'object',
    properties: {
      from: {
        type: 'string',
        description:
          'Existing source path. May be absolute, a ~ path, or relative to the chat working directory.',
      },
      to: {
        type: 'string',
        description:
          'New destination path. May be absolute, a ~ path, or relative to the chat working directory.',
      },
    },
    required: ['from', 'to'],
    additionalProperties: false,
  },
};

export function normalizeMoveFileToolSettings(
  parameters: Record<string, unknown>
): MoveFileToolSettings {
  return normalizePathValidationSettings(parameters);
}

export async function executeMoveFile(
  args: MoveFileToolArgs,
  context: ToolContext
): Promise<MoveFileToolResult> {
  const settings = normalizeMoveFileToolSettings(context.parameters);
  const validationOptions = {
    settings,
    workdir: context.workdir,
    workdirPolicy: context.workdirPolicy,
  };
  const from = resolveAndValidatePath(args.from, validationOptions);
  const to = resolveAndValidatePath(args.to, validationOptions);

  if (from === to) {
    throw new PathAccessError('Source and destination must be different paths.');
  }

  const runtime = await getRuntimeClient(context.userId, context.environmentId);
  const { result, mutations } = await runtime.fs.moveFile(
    {
      chatId: context.chatId,
      inputFrom: args.from,
      inputTo: args.to,
      resolvedFrom: from,
      resolvedTo: to,
      captureSnapshot: Boolean(context.assistantMessageId),
    },
    context.signal ? { signal: context.signal } : undefined
  );
  await persistRuntimeMutations(context, mutations);
  return result;
}

function execute(args: Record<string, unknown>, context: ToolContext): Promise<MoveFileToolResult> {
  const from = getRequiredPathArg(args.from, 'from');
  const to = getRequiredPathArg(args.to, 'to');
  return executeMoveFile({ from, to }, context);
}

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool({
    definition,
    settings: {
      title: 'Move file',
      description:
        'Allows the AI to move or rename regular files without overwriting existing paths.',
      category: 'system',
      enabledByDefault: true,
      canDisable: true,
      defaultParameters: {
        allowedPaths: [],
        deniedPaths: [],
      },
      parameterDescriptors: pathPolicyParameterDescriptors(
        'List of paths the tool is allowed to move files from and to. Leave empty to allow all.',
        'List of paths the tool is denied from moving files from or to. Leave empty to deny none.'
      ),
    },
    execute,
  });
}
