/**
 * Built-in tool: grep
 * Searches files for lines matching a regular expression. Walks directories with
 * Bun.Glob and reads contents via Bun.file so we stay on Bun's native I/O path.
 */

import { stat } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import {
  isInsideResolvedRoot,
  resolveContainmentRoot,
} from '../../../modules/workspaces/application/path-containment';
import { clampIntegerSetting, getOptionalString, ToolArgumentError } from '../arg-parsing';
import { registerTool } from '../registry';
import type { ToolContext } from '../types';
import {
  containsNulByte,
  getRequiredPathArg,
  normalizePathValidationSettings,
  PathAccessError,
  type PathValidationSettings,
  pathPolicyParameterDescriptors,
  resolveAndValidatePath,
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

const BINARY_PROBE_BYTES = 1024;
const DEFAULT_FILE_GLOB = '**/*';

export class GrepPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrepPatternError';
  }
}

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
        minLength: 1,
        description:
          'JavaScript regular expression. Escape special characters when searching for literal text.',
      },
      path: {
        type: 'string',
        description:
          'Optional absolute path, ~ path, or path relative to the chat working directory. Defaults to the chat working directory when available.',
      },
      glob: {
        type: 'string',
        description:
          'Optional glob filter applied to directory searches (e.g. "*.ts", "src/**/*.tsx"). Ignored when path is a single file.',
      },
      caseInsensitive: {
        type: 'boolean',
        description: 'When true, the regular expression is matched case-insensitively.',
      },
    },
    required: ['pattern'],
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
  const regex = buildRegex(args.pattern, args.caseInsensitive === true);
  const path = getRequiredPathArg(args.path ?? context.workdir, 'path');
  const rootPath = resolveAndValidatePath(path, {
    settings,
    workdir: context.workdir,
    workdirPolicy: context.workdirPolicy,
  });
  const rootStats = await statSafe(rootPath, path);

  const matches: GrepMatch[] = [];
  let filesScanned = 0;
  let truncated = false;

  if (rootStats.isFile()) {
    const fileTruncated = await searchFile({
      absolute: rootPath,
      // Absolute: a path relative to the API process directory would be
      // re-resolved against the chat workdir if the model fed it back in.
      display: rootPath,
      regex,
      matches,
      settings,
    });
    filesScanned = 1;
    return {
      pattern: args.pattern,
      path,
      matches,
      filesScanned,
      truncated: fileTruncated,
    };
  }

  if (!rootStats.isDirectory()) {
    throw new PathAccessError(`Path "${path}" is not a regular file or directory.`);
  }

  const filter = args.glob && args.glob.trim().length > 0 ? args.glob.trim() : DEFAULT_FILE_GLOB;
  const fileGlob = new Bun.Glob(filter);

  // Canonicalized once: the per-file containment check runs for every candidate,
  // and re-resolving the root there would cost an extra realpath syscall each time.
  const policy = context.workdirPolicy;
  const containmentRoot = policy?.restricted ? resolveContainmentRoot(policy.root) : undefined;

  try {
    for await (const relativePath of fileGlob.scan({
      cwd: rootPath,
      dot: settings.includeDotfiles,
      onlyFiles: true,
      absolute: false,
    })) {
      const absolute = resolvePath(rootPath, relativePath);
      if (containmentRoot && !isInsideResolvedRoot(containmentRoot, absolute)) continue;
      if (!isPathAllowed(absolute, settings)) continue;
      filesScanned += 1;
      const fileTruncated = await searchFile({
        absolute,
        display: relativePath,
        regex,
        matches,
        settings,
      });
      if (fileTruncated) truncated = true;
      if (matches.length >= settings.maxResults) {
        truncated = true;
        break;
      }
    }
  } catch (error) {
    if (error instanceof PathAccessError) throw error;
    const message = error instanceof Error ? error.message : 'Failed to walk directory';
    throw new PathAccessError(`Cannot search "${path}": ${message}`);
  }

  return {
    pattern: args.pattern,
    path,
    matches,
    filesScanned,
    truncated,
  };
}

interface SearchFileInput {
  absolute: string;
  display: string;
  regex: RegExp;
  matches: GrepMatch[];
  settings: GrepToolSettings;
}

/** Returns true when a per-file or global cap forced us to stop before all matches were recorded. */
async function searchFile(input: SearchFileInput): Promise<boolean> {
  const { absolute, display, regex, matches, settings } = input;
  if (matches.length >= settings.maxResults) return false;

  const file = Bun.file(absolute);
  if (file.size === 0 || file.size > settings.maxFileSizeBytes) return false;

  if (await looksBinary(file)) return false;

  let content: string;
  try {
    content = await file.text();
  } catch {
    return false;
  }

  const lines = content.split('\n');
  let perFile = 0;
  for (let i = 0; i < lines.length; i++) {
    if (perFile >= settings.maxMatchesPerFile || matches.length >= settings.maxResults) {
      // Truncated only if at least one more match would have been recorded.
      for (let j = i; j < lines.length; j++) {
        if (regex.test(lines[j])) return true;
      }
      return false;
    }
    const line = lines[i];
    if (!regex.test(line)) continue;
    matches.push({ file: display, line: i + 1, text: line });
    perFile += 1;
  }
  return false;
}

async function looksBinary(file: ReturnType<typeof Bun.file>): Promise<boolean> {
  const slice = file.slice(0, Math.min(file.size, BINARY_PROBE_BYTES));
  const bytes = new Uint8Array(await slice.arrayBuffer());
  return containsNulByte(bytes, BINARY_PROBE_BYTES);
}

function buildRegex(pattern: string, caseInsensitive: boolean): RegExp {
  try {
    return new RegExp(pattern, caseInsensitive ? 'i' : '');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid regular expression';
    throw new GrepPatternError(`Invalid pattern "${pattern}": ${message}`);
  }
}

async function statSafe(absolute: string, original: string) {
  try {
    return await stat(absolute);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Path is not accessible';
    throw new PathAccessError(`Cannot access "${original}": ${message}`);
  }
}

function isPathAllowed(absolute: string, settings: PathValidationSettings): boolean {
  try {
    resolveAndValidatePath(absolute, { settings });
    return true;
  } catch (error) {
    if (error instanceof PathAccessError) return false;
    throw error;
  }
}

/**
 * Reads the search pattern verbatim. Whitespace is part of a regular
 * expression: trimming `" TODO"` into `"TODO"` silently searches for something
 * the caller never asked for, so only an absent, non-string, or empty pattern
 * is rejected.
 */
function getRequiredPatternArg(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new ToolArgumentError('Missing required field "pattern".');
  }
  return value;
}

function execute(args: Record<string, unknown>, context: ToolContext): Promise<GrepToolResult> {
  const pattern = getRequiredPatternArg(args.pattern);
  const path = getOptionalString(args.path);
  const glob = getOptionalString(args.glob);
  return executeGrep(
    {
      pattern,
      ...(path ? { path } : {}),
      ...(glob ? { glob } : {}),
      caseInsensitive: args.caseInsensitive === true,
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
