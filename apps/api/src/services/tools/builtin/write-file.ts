/**
 * Built-in tool: write_file
 * Writes text content to a file on disk, creating parent directories as needed.
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getRequiredString } from '../arg-parsing';
import { registerTool } from '../registry';
import type { ToolContext } from '../types';
import {
  getRequiredPathArg,
  normalizePathList,
  type PathValidationSettings,
  resolveAndValidatePath,
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
}

export type WriteFileToolSettings = PathValidationSettings;

const definition = {
  name: WRITE_FILE_TOOL_NAME,
  description:
    'Writes text content to a file on disk. Creates parent directories if they do not exist. ' +
    'Use this when the user asks to create, write, or save content to a file.',
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
  return {
    allowedPaths: normalizePathList(parameters.allowedPaths),
    deniedPaths: normalizePathList(parameters.deniedPaths),
  };
}

export async function executeWriteFile(
  args: WriteFileToolArgs,
  context: ToolContext
): Promise<WriteFileToolResult> {
  const settings = normalizeWriteFileToolSettings(context.parameters);
  const resolvedPath = resolveAndValidatePath(args.path, {
    settings,
    workdir: context.workdir,
    workdirPolicy: context.workdirPolicy,
  });

  const existingFile = Bun.file(resolvedPath);
  const created = !(await existingFile.exists());

  const dir = dirname(resolvedPath);
  await mkdir(dir, { recursive: true });

  const bytesWritten = await Bun.write(resolvedPath, args.content);

  return { path: args.path, bytesWritten, created };
}

function execute(
  args: Record<string, unknown>,
  context: ToolContext
): Promise<WriteFileToolResult> {
  const path = getRequiredPathArg(args.path, 'path');
  const content = getRequiredString(args.content, 'content');
  return executeWriteFile({ path, content }, context);
}

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool({
    definition,
    settings: {
      title: 'Write file',
      description: 'Allows the AI to write text content to files on disk.',
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
          description: 'List of paths the tool is allowed to write to. Leave empty to allow all.',
          type: 'path_list',
          required: false,
          defaultValue: [] as Array<{ path: string; enabled: boolean }>,
        },
        {
          name: 'deniedPaths',
          label: 'Denied paths',
          description:
            'List of paths the tool is denied from writing to. Leave empty to deny none.',
          type: 'path_list',
          required: false,
          defaultValue: [] as Array<{ path: string; enabled: boolean }>,
        },
      ],
    },
    execute,
  });
}
