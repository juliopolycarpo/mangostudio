/**
 * Built-in tool: grep
 * Searches files for lines matching a regular expression.
 */

import { GrepPatternError } from '@mangostudio/runtime';
import { getRuntimeClient } from '../../runtime-client';
import {
  clampIntegerSetting,
  getOptionalBoolean,
  getOptionalString,
  getRequiredVerbatimString,
} from '../arg-parsing';
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

const GREP_TOOL_NAME = 'grep';

export const GREP_DEFAULT_MAX_RESULTS = 100;
export const GREP_MIN_MAX_RESULTS = 1;
export const GREP_MAX_MAX_RESULTS = 5_000;

export const GREP_DEFAULT_MAX_PER_FILE = 20;
const GREP_MIN_MAX_PER_FILE = 1;
const GREP_MAX_MAX_PER_FILE = 1_000;

export const GREP_DEFAULT_MAX_FILE_BYTES = 1_000_000;
const GREP_MIN_MAX_FILE_BYTES = 1_000;
const GREP_MAX_MAX_FILE_BYTES = 10_000_000;

export { GrepPatternError };

export interface GrepToolArgs {
  pattern: string;
  path?: string;
  glob?: string;
  caseInsensitive?: boolean;
}

interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

export interface GrepToolResult {
  pattern: string;
  path: string;
  matches: GrepMatch[];
  filesScanned: number;
  truncated: boolean;
}

export interface GrepToolSettings extends PathValidationSettings {
  maxResults: number;
  maxMatchesPerFile: number;
  maxFileSizeBytes: number;
  includeDotfiles: boolean;
}

const definition = {
  name: GREP_TOOL_NAME,
  description:
    'Searches files for lines that match a regular expression and returns the file, line number, and line text. ' +
    'Use this when the user asks to find code, strings, or patterns across files.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description:
          'JavaScript regular expression. Escape special characters when searching for literal text.',
      },
      path: {
        type: ['string', 'null'],
        description:
          'Absolute path, ~ path, or path relative to the chat working directory. Pass null to search the chat working directory.',
      },
      glob: {
        type: ['string', 'null'],
        description:
          'Glob filter applied to directory searches (e.g. "*.ts", "src/**/*.tsx"). Ignored when path is a single file. Pass null for no filter.',
      },
      caseInsensitive: {
        type: ['boolean', 'null'],
        description:
          'When true, the regular expression is matched case-insensitively. Pass null or false for a case-sensitive search.',
      },
    },
    required: ['pattern', 'path', 'glob', 'caseInsensitive'],
    additionalProperties: false,
  },
};

export function normalizeGrepToolSettings(parameters: Record<string, unknown>): GrepToolSettings {
  return {
    ...normalizePathValidationSettings(parameters),
    maxResults: clampIntegerSetting(
      parameters.maxResults,
      GREP_DEFAULT_MAX_RESULTS,
      GREP_MIN_MAX_RESULTS,
      GREP_MAX_MAX_RESULTS
    ),
    maxMatchesPerFile: clampIntegerSetting(
      parameters.maxMatchesPerFile,
      GREP_DEFAULT_MAX_PER_FILE,
      GREP_MIN_MAX_PER_FILE,
      GREP_MAX_MAX_PER_FILE
    ),
    maxFileSizeBytes: clampIntegerSetting(
      parameters.maxFileSizeBytes,
      GREP_DEFAULT_MAX_FILE_BYTES,
      GREP_MIN_MAX_FILE_BYTES,
      GREP_MAX_MAX_FILE_BYTES
    ),
    includeDotfiles: parameters.includeDotfiles === true,
  };
}

export async function executeGrep(
  args: GrepToolArgs,
  context: ToolContext
): Promise<GrepToolResult> {
  const settings = normalizeGrepToolSettings(context.parameters);
  const path = getRequiredPathArg(args.path ?? context.workdir, 'path');
  const runtime = await getRuntimeClient(context.userId, context.environmentId);
  const options = {
    settings,
    workdir: context.workdir,
    workdirPolicy: context.workdirPolicy,
    paths: runtime.paths,
  };
  const rootPath = resolveAndValidatePath(path, options);
  const result = await runtime.fs.grep(
    {
      pattern: args.pattern,
      inputPath: path,
      resolvedPath: rootPath,
      ...(args.glob ? { glob: args.glob } : {}),
      caseInsensitive: args.caseInsensitive === true,
      maxResults: settings.maxResults,
      maxMatchesPerFile: settings.maxMatchesPerFile,
      maxFileSizeBytes: settings.maxFileSizeBytes,
      includeDotfiles: settings.includeDotfiles,
      ...runtimePathPolicy(options),
    },
    context.signal ? { signal: context.signal } : undefined
  );
  return { ...result, matches: [...result.matches] };
}

function execute(args: Record<string, unknown>, context: ToolContext): Promise<GrepToolResult> {
  // Verbatim: whitespace is part of the regular expression.
  const pattern = getRequiredVerbatimString(args.pattern, 'pattern');
  const path = getOptionalString(args.path, 'path');
  const glob = getOptionalString(args.glob, 'glob');
  const caseInsensitive = getOptionalBoolean(args.caseInsensitive, 'caseInsensitive');
  return executeGrep(
    {
      pattern,
      ...(path ? { path } : {}),
      ...(glob ? { glob } : {}),
      caseInsensitive: caseInsensitive === true,
    },
    context
  );
}

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool({
    definition,
    settings: {
      title: 'Grep',
      description: 'Allows the AI to search file contents with regular expressions.',
      category: 'system',
      enabledByDefault: true,
      canDisable: true,
      requiredCapabilities: ['fsRead'],
      defaultParameters: {
        allowedPaths: [],
        deniedPaths: [],
        maxResults: GREP_DEFAULT_MAX_RESULTS,
        maxMatchesPerFile: GREP_DEFAULT_MAX_PER_FILE,
        maxFileSizeBytes: GREP_DEFAULT_MAX_FILE_BYTES,
        includeDotfiles: false,
      },
      parameterDescriptors: [
        ...pathPolicyParameterDescriptors(
          'Paths the tool may search. Leave empty to allow all.',
          'Paths the tool must not search. Leave empty to deny none.'
        ),
        {
          name: 'maxResults',
          label: 'Maximum matches',
          description: 'Caps the total number of matched lines returned across all files.',
          type: 'number',
          required: true,
          defaultValue: GREP_DEFAULT_MAX_RESULTS,
          min: GREP_MIN_MAX_RESULTS,
          max: GREP_MAX_MAX_RESULTS,
        },
        {
          name: 'maxMatchesPerFile',
          label: 'Maximum matches per file',
          description: 'Prevents a single file from filling the result list.',
          type: 'number',
          required: true,
          defaultValue: GREP_DEFAULT_MAX_PER_FILE,
          min: GREP_MIN_MAX_PER_FILE,
          max: GREP_MAX_MAX_PER_FILE,
        },
        {
          name: 'maxFileSizeBytes',
          label: 'Maximum file size (bytes)',
          description: 'Files larger than this are skipped to avoid slow scans.',
          type: 'number',
          required: true,
          defaultValue: GREP_DEFAULT_MAX_FILE_BYTES,
          min: GREP_MIN_MAX_FILE_BYTES,
          max: GREP_MAX_MAX_FILE_BYTES,
        },
        {
          name: 'includeDotfiles',
          label: 'Include dotfiles',
          description: 'When enabled, files and directories starting with "." are also searched.',
          type: 'boolean',
          required: true,
          defaultValue: false,
        },
      ],
    },
    execute,
  });
}
