/**
 * Built-in tool: glob
 * Returns filesystem paths matching a glob pattern, evaluated by Bun.Glob.
 */

import { getRuntimeClient } from '../../runtime-client';
import { clampIntegerSetting, getOptionalString, getRequiredString } from '../arg-parsing';
import { registerTool } from '../registry';
import type { ToolContext } from '../types';
import {
  normalizePathValidationSettings,
  PathAccessError,
  type PathValidationSettings,
  pathPolicyParameterDescriptors,
  type ResolvePathOptions,
  resolveAndValidatePath,
  runtimePathPolicy,
} from './_fs-utils';

const GLOB_TOOL_NAME = 'glob';

export const GLOB_DEFAULT_MAX_RESULTS = 200;
export const GLOB_MIN_MAX_RESULTS = 1;
export const GLOB_MAX_MAX_RESULTS = 5_000;

export interface GlobToolArgs {
  pattern: string;
  cwd?: string;
}

export interface GlobToolResult {
  pattern: string;
  cwd: string;
  matches: string[];
  truncated: boolean;
}

export interface GlobToolSettings extends PathValidationSettings {
  maxResults: number;
  includeDotfiles: boolean;
  absolute: boolean;
}

const definition = {
  name: GLOB_TOOL_NAME,
  description:
    'Finds files and directories whose paths match a glob pattern (e.g. "**/*.ts", "src/**/!(*.test).ts"). ' +
    'Use this when the user asks to locate files by name or extension, or to enumerate paths matching a shape.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        minLength: 1,
        description:
          'Glob pattern. Supports *, **, ?, [], {a,b} and ! for negation. Evaluated against paths relative to cwd.',
      },
      cwd: {
        type: 'string',
        description:
          'Optional absolute path, ~ path, or path relative to the chat working directory. Defaults to the chat working directory.',
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
};

export function normalizeGlobToolSettings(parameters: Record<string, unknown>): GlobToolSettings {
  return {
    ...normalizePathValidationSettings(parameters),
    maxResults: clampIntegerSetting(
      parameters.maxResults,
      GLOB_DEFAULT_MAX_RESULTS,
      GLOB_MIN_MAX_RESULTS,
      GLOB_MAX_MAX_RESULTS
    ),
    includeDotfiles: parameters.includeDotfiles === true,
    absolute: parameters.absolute === true,
  };
}

export async function executeGlob(
  args: GlobToolArgs,
  context: ToolContext
): Promise<GlobToolResult> {
  const settings = normalizeGlobToolSettings(context.parameters);
  const runtime = await getRuntimeClient(context.userId, context.environmentId);
  const options = {
    settings,
    workdir: context.workdir,
    workdirPolicy: context.workdirPolicy,
    paths: runtime.paths,
  };
  const cwd = resolveCwd(args.cwd, options, context);

  const result = await runtime.fs.glob(
    {
      pattern: args.pattern,
      cwd,
      maxResults: settings.maxResults,
      includeDotfiles: settings.includeDotfiles,
      absolute: settings.absolute,
      ...runtimePathPolicy(options),
    },
    context.signal ? { signal: context.signal } : undefined
  );
  return { ...result, matches: [...result.matches] };
}

/**
 * The hub's own working directory is not a legal answer here: the search runs
 * on the environment, whose filesystem need not contain it at all. With no cwd
 * argument and no workdir bound to the chat there is nothing to search, which
 * is the same conclusion every other filesystem tool reaches for a relative
 * path it cannot anchor.
 */
function resolveCwd(
  input: string | undefined,
  options: ResolvePathOptions,
  context: ToolContext
): string {
  const policy = context.workdirPolicy;
  const base = input?.trim() || (policy?.restricted ? policy.root : context.workdir);
  if (!base) {
    throw new PathAccessError(
      'No directory to search: this chat has no working directory bound. Pass an absolute cwd.'
    );
  }
  return resolveAndValidatePath(base, options);
}

function execute(args: Record<string, unknown>, context: ToolContext): Promise<GlobToolResult> {
  const pattern = getRequiredString(args.pattern, 'pattern');
  const cwd = getOptionalString(args.cwd);
  return executeGlob({ pattern, ...(cwd ? { cwd } : {}) }, context);
}

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool({
    definition,
    settings: {
      title: 'Glob',
      description: 'Allows the AI to find files and directories by glob pattern.',
      category: 'system',
      enabledByDefault: true,
      canDisable: true,
      requiredCapabilities: ['fsRead'],
      defaultParameters: {
        allowedPaths: [],
        deniedPaths: [],
        maxResults: GLOB_DEFAULT_MAX_RESULTS,
        includeDotfiles: false,
        absolute: false,
      },
      parameterDescriptors: [
        ...pathPolicyParameterDescriptors(
          'Paths the tool may scan. Leave empty to allow all.',
          'Paths the tool must not scan. Leave empty to deny none.'
        ),
        {
          name: 'maxResults',
          label: 'Maximum matches',
          description: 'Caps the number of paths returned by a single call.',
          type: 'number',
          required: true,
          defaultValue: GLOB_DEFAULT_MAX_RESULTS,
          min: GLOB_MIN_MAX_RESULTS,
          max: GLOB_MAX_MAX_RESULTS,
        },
        {
          name: 'includeDotfiles',
          label: 'Include dotfiles',
          description: 'When enabled, files and directories starting with "." are also matched.',
          type: 'boolean',
          required: true,
          defaultValue: false,
        },
        {
          name: 'absolute',
          label: 'Return absolute paths',
          description: 'When enabled, results are absolute paths instead of relative to cwd.',
          type: 'boolean',
          required: true,
          defaultValue: false,
        },
      ],
    },
    execute,
  });
}
