import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PathAccessError, RuntimeServiceError } from '../../errors';
import type { RuntimeGrepParams, RuntimeGrepResult } from '../../methods';
import { containsNulByte, isRuntimePathAllowed } from '../fs-utils';

const BINARY_PROBE_BYTES = 1024;
const DEFAULT_FILE_GLOB = '**/*';

export class GrepPatternError extends RuntimeServiceError {
  constructor(message: string) {
    super('grep_pattern', message);
    this.name = 'GrepPatternError';
  }
}

export async function grepRuntimeFiles(params: RuntimeGrepParams): Promise<RuntimeGrepResult> {
  const regex = buildRegex(params.pattern, params.caseInsensitive);
  const rootStats = await statSafe(params.resolvedPath, params.inputPath);
  const matches: Array<{ file: string; line: number; text: string }> = [];
  let filesScanned = 0;
  let truncated = false;

  if (rootStats.isFile()) {
    const fileTruncated = await searchFile({
      absolute: params.resolvedPath,
      display: params.resolvedPath,
      regex,
      matches,
      params,
    });
    return {
      pattern: params.pattern,
      path: params.inputPath,
      matches,
      filesScanned: 1,
      truncated: fileTruncated,
    };
  }

  if (!rootStats.isDirectory()) {
    throw new PathAccessError(`Path "${params.inputPath}" is not a regular file or directory.`);
  }

  const filter = params.glob?.trim() || DEFAULT_FILE_GLOB;
  const fileGlob = new Bun.Glob(filter);
  try {
    for await (const relativePath of fileGlob.scan({
      cwd: params.resolvedPath,
      dot: params.includeDotfiles,
      onlyFiles: true,
      absolute: false,
    })) {
      const absolute = resolve(params.resolvedPath, relativePath);
      if (!isRuntimePathAllowed(absolute, params)) continue;
      filesScanned++;
      const fileTruncated = await searchFile({
        absolute,
        display: relativePath,
        regex,
        matches,
        params,
      });
      if (fileTruncated) truncated = true;
      if (matches.length >= params.maxResults) {
        truncated = true;
        break;
      }
    }
  } catch (error) {
    if (error instanceof PathAccessError) throw error;
    const message = error instanceof Error ? error.message : 'Failed to walk directory';
    throw new PathAccessError(`Cannot search "${params.inputPath}": ${message}`);
  }

  return {
    pattern: params.pattern,
    path: params.inputPath,
    matches,
    filesScanned,
    truncated,
  };
}

interface SearchFileInput {
  readonly absolute: string;
  readonly display: string;
  readonly regex: RegExp;
  readonly matches: Array<{ file: string; line: number; text: string }>;
  readonly params: RuntimeGrepParams;
}

async function searchFile(input: SearchFileInput): Promise<boolean> {
  const { absolute, display, regex, matches, params } = input;
  if (matches.length >= params.maxResults) return false;

  const file = Bun.file(absolute);
  if (file.size === 0 || file.size > params.maxFileSizeBytes) return false;
  if (await looksBinary(file)) return false;

  let content: string;
  try {
    content = await file.text();
  } catch {
    return false;
  }

  const lines = content.split('\n');
  let perFile = 0;
  for (let index = 0; index < lines.length; index++) {
    if (perFile >= params.maxMatchesPerFile || matches.length >= params.maxResults) {
      for (let rest = index; rest < lines.length; rest++) {
        if (regex.test(lines[rest])) return true;
      }
      return false;
    }
    const line = lines[index];
    if (!regex.test(line)) continue;
    matches.push({ file: display, line: index + 1, text: line });
    perFile++;
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
