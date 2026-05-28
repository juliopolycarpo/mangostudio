/**
 * Built-in tool: grep
 * Searches files for lines matching a regular expression. Walks directories with
 * Bun.Glob and reads contents via Bun.file so we stay on Bun's native I/O path.
 */

import { stat } from 'node:fs/promises';
import { relative, resolve as resolvePath } from 'node:path';
import { getOptionalString, getRequiredString } from '../arg-parsing';
import { registerTool } from '../registry';
import type { ToolContext } from '../types';
import {
  expandHome,
  getRequiredPathArg,
  normalizePathList,
  PathAccessError,
  type PathValidationSettings,
  resolveAndValidatePath,
} from './_fs-utils';

export const GREP_TOOL_NAME = 'grep';

export const GREP_DEFAULT_MAX_RESULTS = 100;
export const GREP_MIN_MAX_RESULTS = 1;
export const GREP_MAX_MAX_RESULTS = 5_000;

export const GREP_DEFAULT_MAX_PER_FILE = 20;
export const GREP_MIN_MAX_PER_FILE = 1;
export const GREP_MAX_MAX_PER_FILE = 1_000;

export const GREP_DEFAULT_MAX_FILE_BYTES = 1_000_000;
export const GREP_MIN_MAX_FILE_BYTES = 1_000;
export const GREP_MAX_MAX_FILE_BYTES = 10_000_000;

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
  path: string;
  glob?: string;
  caseInsensitive?: boolean;
}

export interface GrepMatch {
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
          'File or directory to search. Absolute path or one starting with ~. Directories are scanned recursively.',
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
    required: ['pattern', 'path'],
    additionalProperties: false,
  },
};

export function normalizeGrepToolSettings(parameters: Record<string, unknown>): GrepToolSettings {
  return {
    allowedPaths: normalizePathList(parameters.allowedPaths),
    deniedPaths: normalizePathList(parameters.deniedPaths),
    maxResults: clampInteger(
      parameters.maxResults,
      GREP_DEFAULT_MAX_RESULTS,
      GREP_MIN_MAX_RESULTS,
      GREP_MAX_MAX_RESULTS
    ),
    maxMatchesPerFile: clampInteger(
      parameters.maxMatchesPerFile,
      GREP_DEFAULT_MAX_PER_FILE,
      GREP_MIN_MAX_PER_FILE,
      GREP_MAX_MAX_PER_FILE
    ),
    maxFileSizeBytes: clampInteger(
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
  const rootPath = resolveAndValidatePath(expandHome(args.path), settings);
  const rootStats = await statSafe(rootPath, args.path);

  const matches: GrepMatch[] = [];
  let filesScanned = 0;
  let truncated = false;

  if (rootStats.isFile()) {
    await searchFile({
      absolute: rootPath,
      display: relative(process.cwd(), rootPath) || rootPath,
      regex,
      matches,
      settings,
    });
    filesScanned = 1;
    truncated = matches.length >= settings.maxResults;
    return {
      pattern: args.pattern,
      path: args.path,
      matches,
      filesScanned,
      truncated,
    };
  }

  if (!rootStats.isDirectory()) {
    throw new PathAccessError(`Path "${args.path}" is not a regular file or directory.`);
  }

  const filter = args.glob && args.glob.trim().length > 0 ? args.glob.trim() : DEFAULT_FILE_GLOB;
  const fileGlob = new Bun.Glob(filter);

  try {
    for await (const relativePath of fileGlob.scan({
      cwd: rootPath,
      dot: settings.includeDotfiles,
      onlyFiles: true,
      absolute: false,
    })) {
      const absolute = resolvePath(rootPath, relativePath);
      if (!isPathAllowed(absolute, settings)) continue;
      filesScanned += 1;
      await searchFile({
        absolute,
        display: relativePath,
        regex,
        matches,
        settings,
      });
      if (matches.length >= settings.maxResults) {
        truncated = true;
        break;
      }
    }
  } catch (error) {
    if (error instanceof PathAccessError) throw error;
    const message = error instanceof Error ? error.message : 'Failed to walk directory';
    throw new PathAccessError(`Cannot search "${args.path}": ${message}`);
  }

  return {
    pattern: args.pattern,
    path: args.path,
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

async function searchFile(input: SearchFileInput): Promise<void> {
  const { absolute, display, regex, matches, settings } = input;
  if (matches.length >= settings.maxResults) return;

  const file = Bun.file(absolute);
  if (file.size === 0 || file.size > settings.maxFileSizeBytes) return;

  if (await looksBinary(file)) return;

  let content: string;
  try {
    content = await file.text();
  } catch {
    return;
  }

  const lines = content.split('\n');
  let perFile = 0;
  for (let i = 0; i < lines.length; i++) {
    if (perFile >= settings.maxMatchesPerFile) break;
    if (matches.length >= settings.maxResults) break;
    const line = lines[i];
    if (!regex.test(line)) continue;
    matches.push({ file: display, line: i + 1, text: line });
    perFile += 1;
  }
}

async function looksBinary(file: ReturnType<typeof Bun.file>): Promise<boolean> {
  const slice = file.slice(0, Math.min(file.size, BINARY_PROBE_BYTES));
  const bytes = new Uint8Array(await slice.arrayBuffer());
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
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
    resolveAndValidatePath(absolute, settings);
    return true;
  } catch (error) {
    if (error instanceof PathAccessError) return false;
    throw error;
  }
}

function execute(args: Record<string, unknown>, context: ToolContext): Promise<GrepToolResult> {
  const pattern = getRequiredString(args.pattern, 'pattern');
  const path = getRequiredPathArg(args.path, 'path');
  const glob = getOptionalString(args.glob);
  return executeGrep(
    {
      pattern,
      path,
      ...(glob ? { glob } : {}),
      caseInsensitive: args.caseInsensitive === true,
    },
    context
  );
}

/** Registers this tool. Called once at import time; can be re-called after clearRegistry(). */
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
        {
          name: 'allowedPaths',
          label: 'Allowed paths',
          description: 'Paths the tool may search. Leave empty to allow all.',
          type: 'path_list',
          required: false,
          defaultValue: [] as Array<{ path: string; enabled: boolean }>,
        },
        {
          name: 'deniedPaths',
          label: 'Denied paths',
          description: 'Paths the tool must not search. Leave empty to deny none.',
          type: 'path_list',
          required: false,
          defaultValue: [] as Array<{ path: string; enabled: boolean }>,
        },
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

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}

// Self-register on import
register();
