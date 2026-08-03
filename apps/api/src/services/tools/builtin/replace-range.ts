/**
 * Built-in tool: replace_range
 * Replaces an inclusive range of lines in an existing file.
 */

import { getRuntimeClient } from '../../runtime-client';
import { getRequiredInteger, getRequiredTextArg } from '../arg-parsing';
import { attachBeforeFields, persistRuntimeMutations } from '../file-mutation-snapshot';
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

const REPLACE_RANGE_TOOL_NAME = 'replace_range';

export interface ReplaceRangeToolArgs {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface ReplaceRangeToolResult {
  path: string;
  replacedLines: number;
  newTotalLines: number;
  sha256: string;
  before?: string;
  beforeOmitted?: 'binary' | 'too_large' | 'missing';
}

export type ReplaceRangeToolSettings = PathValidationSettings;

const definition = {
  name: REPLACE_RANGE_TOOL_NAME,
  description:
    'Replaces a 1-indexed inclusive line range in an existing text file. Line numbers refer ' +
    'to the file as last read with read_file. The file must be read completely first. If the ' +
    'file is stale, re-read it before retrying. The replacement may contain any number of lines ' +
    'or be empty to delete the range. A call that changes the line count renumbers every line ' +
    'after the range it replaced, so the tool then refuses later ranges reaching past that ' +
    'point until the file is read again.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path, ~ path, or path relative to the chat working directory.',
      },
      startLine: {
        type: 'integer',
        minimum: 1,
        description: 'First line to replace, using 1-indexed inclusive line numbers.',
      },
      endLine: {
        type: 'integer',
        minimum: 1,
        description: 'Last line to replace, using 1-indexed inclusive line numbers.',
      },
      content: {
        type: 'string',
        description: 'Replacement text. Use an empty string to delete the selected lines.',
      },
    },
    required: ['path', 'startLine', 'endLine', 'content'],
    additionalProperties: false,
  },
};

export function normalizeReplaceRangeToolSettings(
  parameters: Record<string, unknown>
): ReplaceRangeToolSettings {
  return normalizePathValidationSettings(parameters);
}

export async function executeReplaceRange(
  args: ReplaceRangeToolArgs,
  context: ToolContext
): Promise<ReplaceRangeToolResult> {
  const settings = normalizeReplaceRangeToolSettings(context.parameters);
  const runtime = await getRuntimeClient(context.userId, context.environmentId);
  const options = {
    settings,
    workdir: context.workdir,
    workdirPolicy: context.workdirPolicy,
    paths: runtime.paths,
  };
  const resolvedPath = resolveAndValidatePath(args.path, options);

  const { result, mutations } = await runtime.fs.replaceRange(
    {
      chatId: context.chatId,
      inputPath: args.path,
      resolvedPath,
      startLine: args.startLine,
      endLine: args.endLine,
      content: args.content,
      captureSnapshot: Boolean(context.assistantMessageId),
      ...runtimePathPolicy(options),
    },
    context.signal ? { signal: context.signal } : undefined
  );
  const [captured] = await persistRuntimeMutations(context, mutations);
  return attachBeforeFields(result, captured);
}

function execute(
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ReplaceRangeToolResult> {
  const path = getRequiredPathArg(args.path, 'path');
  const startLine = getRequiredInteger(args.startLine, 'startLine');
  const endLine = getRequiredInteger(args.endLine, 'endLine');
  const content = getRequiredTextArg(args.content, 'content');
  return executeReplaceRange({ path, startLine, endLine, content }, context);
}

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool({
    definition,
    settings: {
      title: 'Replace range',
      description: 'Allows the AI to replace inclusive line ranges in files read in this chat.',
      category: 'system',
      enabledByDefault: true,
      canDisable: true,
      requiredCapabilities: ['fsWrite'],
      defaultParameters: {
        allowedPaths: [],
        deniedPaths: [],
      },
      parameterDescriptors: pathPolicyParameterDescriptors(
        'List of paths where the tool may replace line ranges. Leave empty to allow all.',
        'List of paths where the tool may not replace line ranges. Leave empty to deny none.'
      ),
    },
    execute,
  });
}
