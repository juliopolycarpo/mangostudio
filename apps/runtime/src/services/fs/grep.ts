import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PathAccessError, RuntimeServiceError } from '../../errors';
import type { RuntimeGrepParams, RuntimeGrepResult } from '../../methods';
import { throwIfAborted } from '../cancellation';
import { compilePolicyGuard } from '../fs-path-policy';
import { containsNulByte } from '../fs-utils';
import { createGrepScanner, type GrepScanner } from './grep-scanner';

const BINARY_PROBE_BYTES = 1024;

/**
 * Wall-clock allowance for matching one file, enforced by terminating the
 * worker that holds the scan.
 *
 * This is an event-loop protection, not a performance target: a file that needs
 * two seconds of regular-expression evaluation has already found a pattern the
 * engine cannot bound, and every other tool call, HTTP request and timer in the
 * hub is waiting behind whatever comes next.
 */
const GREP_FILE_BUDGET_MS = 2000;

/**
 * Longest pattern accepted. Length is not a soundness check — a nine-character
 * pattern backtracks catastrophically, and {@link GREP_FILE_BUDGET_MS} is what
 * actually bounds the damage. It only keeps a pattern the model cannot have
 * meant out of the regular-expression compiler.
 */
const GREP_MAX_PATTERN_LENGTH = 1000;

const DEFAULT_FILE_GLOB = '**/*';

export class GrepPatternError extends RuntimeServiceError {
  constructor(message: string) {
    super('grep_pattern', message);
    this.name = 'GrepPatternError';
  }
}

export async function grepRuntimeFiles(
  params: RuntimeGrepParams,
  signal?: AbortSignal
): Promise<RuntimeGrepResult> {
  const regex = buildRegex(params.pattern, params.caseInsensitive);
  const allows = compilePolicyGuard(params.pathPolicy);
  const rootStats = await statSafe(params.resolvedPath, params.inputPath);
  const matches: Array<{ file: string; line: number; text: string }> = [];
  let filesScanned = 0;
  let truncated = false;

  const scanner = createGrepScanner(regex);
  try {
    if (rootStats.isFile()) {
      // The directory branch filters every candidate it discovers; a single-file
      // search is subject to the same policy, and the runtime is the boundary
      // that has to enforce it once the hub is no longer in-process.
      if (!allows(params.resolvedPath)) {
        throw new PathAccessError(`Path "${params.inputPath}" is not searchable by this tool.`);
      }
      const fileTruncated = await searchFile({
        absolute: params.resolvedPath,
        display: params.resolvedPath,
        scanner,
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
        // Between files, because that is the only place a walk can stop. The
        // per-file budget bounds the other direction — one file's scan — and the
        // two compose: a cancelled search of many pathological files still ends
        // one budget after the hub asked it to.
        throwIfAborted(signal);
        const absolute = resolve(params.resolvedPath, relativePath);
        if (!allows(absolute)) continue;
        filesScanned++;
        const fileTruncated = await searchFile({
          absolute,
          display: relativePath,
          scanner,
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
      if (error instanceof RuntimeServiceError) throw error;
      // A cancelled walk is the hub's answer, not a path failure.
      if (error instanceof Error && error.name === 'AbortError') throw error;
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
  } finally {
    await scanner.close();
  }
}

interface SearchFileInput {
  readonly absolute: string;
  readonly display: string;
  readonly scanner: GrepScanner;
  readonly matches: Array<{ file: string; line: number; text: string }>;
  readonly params: RuntimeGrepParams;
}

async function searchFile(input: SearchFileInput): Promise<boolean> {
  const { absolute, display, scanner, matches, params } = input;
  const allowance = Math.min(params.maxMatchesPerFile, params.maxResults - matches.length);
  if (allowance <= 0) return false;

  const file = Bun.file(absolute);
  if (file.size === 0 || file.size > params.maxFileSizeBytes) return false;
  if (await looksBinary(file)) return false;

  const outcome = await scanner.scan(absolute, allowance, GREP_FILE_BUDGET_MS);
  for (const match of outcome.matches) {
    matches.push({ file: display, line: match.line, text: match.text });
  }
  // A file the budget cut short was only partly examined, so the search cannot
  // claim to have found everything in it.
  return outcome.moreMatches || outcome.timedOut;
}

async function looksBinary(file: ReturnType<typeof Bun.file>): Promise<boolean> {
  const slice = file.slice(0, Math.min(file.size, BINARY_PROBE_BYTES));
  const bytes = new Uint8Array(await slice.arrayBuffer());
  return containsNulByte(bytes, BINARY_PROBE_BYTES);
}

function buildRegex(pattern: string, caseInsensitive: boolean): RegExp {
  if (pattern.length > GREP_MAX_PATTERN_LENGTH) {
    throw new GrepPatternError(
      `Pattern is ${pattern.length} characters, past the ${GREP_MAX_PATTERN_LENGTH}-character limit.`
    );
  }
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
