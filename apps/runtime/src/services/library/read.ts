/**
 * Contained library content reads. A path is only readable when it sits inside
 * one of the registered location roots the hub named for this request — the
 * same containment idea as workspace file ops, applied to agent homes.
 */

import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import type { ResourceKind } from '@mangostudio/shared/library';
import { RuntimeToolArgumentError } from '../../errors';
import { type LibraryInstanceReaderFs, MAX_LIBRARY_FILE_BYTES } from './instance-reader';

/** Default ceiling for a detail-view content read (hub passes its own when different). */
export const MAX_LIBRARY_CONTENT_BYTES = 512 * 1024;

export interface LibraryReadParams {
  /** Absolute path of the file to read (skill entrypoints are already joined). */
  readonly path: string;
  /** Absolute roots of the locations this scan was allowed to see. */
  readonly allowedRoots: readonly string[];
  readonly maxBytes?: number;
  /** When true, oversize files return truncated text instead of refusing. */
  readonly truncateOversize?: boolean;
}

export interface LibraryReadResult {
  readonly content: string;
  readonly truncated: boolean;
  readonly sizeBytes: number;
}

export class LibraryReadDeniedError extends Error {
  readonly code = 'LIBRARY_READ_DENIED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'LibraryReadDeniedError';
  }
}

const textDecoder = new TextDecoder();

const nodeFs: LibraryInstanceReaderFs = {
  readDirectory: (path) => readdir(path, { withFileTypes: true }),
  readFile,
  realPath: realpath,
  async stat(path) {
    const value = await stat(path);
    return {
      size: value.size,
      mtimeMs: value.mtimeMs,
      isFile: value.isFile(),
      isDirectory: value.isDirectory(),
    };
  },
};

/**
 * Builds the absolute content path for a resource instance. Skills are
 * directories; everything else is a single file at the instance path.
 */
export function libraryContentPath(
  kind: ResourceKind,
  instancePath: string,
  entrypoint = 'SKILL.md'
): string {
  return kind === 'skill' ? join(instancePath, entrypoint) : instancePath;
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const caseInsensitive = /^[A-Za-z]:[\\/]/.test(rootPath);
  const root = caseInsensitive ? rootPath.toLowerCase() : rootPath;
  const candidate = caseInsensitive ? candidatePath.toLowerCase() : candidatePath;
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export async function readLibraryContent(
  params: LibraryReadParams,
  fs: LibraryInstanceReaderFs = nodeFs
): Promise<LibraryReadResult> {
  if (typeof params.path !== 'string' || params.path.length === 0) {
    throw new RuntimeToolArgumentError('library.read requires a non-empty path.');
  }
  if (!Array.isArray(params.allowedRoots) || params.allowedRoots.length === 0) {
    throw new RuntimeToolArgumentError('library.read requires at least one allowed root.');
  }

  let canonicalPath: string;
  try {
    canonicalPath = await fs.realPath(params.path);
  } catch {
    throw new LibraryReadDeniedError(`Library path "${params.path}" is not readable.`);
  }

  const allowedCanonical: string[] = [];
  for (const root of params.allowedRoots) {
    try {
      allowedCanonical.push(await fs.realPath(root));
    } catch {
      // A missing root cannot contain anything; skip it.
    }
  }
  if (!allowedCanonical.some((root) => isPathWithin(root, canonicalPath))) {
    throw new LibraryReadDeniedError(
      `Library path "${params.path}" is outside every registered location.`
    );
  }

  const maxBytes = params.maxBytes ?? MAX_LIBRARY_CONTENT_BYTES;
  const bytes = await fs.readFile(params.path);
  if (bytes.byteLength > MAX_LIBRARY_FILE_BYTES && params.truncateOversize !== true) {
    // Detail reads may truncate; an unbounded dump of a huge asset is refused.
    if (bytes.byteLength > maxBytes) {
      throw new LibraryReadDeniedError(
        `Library file "${basename(params.path)}" exceeds the ${maxBytes} byte cap.`
      );
    }
  }
  const truncated = bytes.byteLength > maxBytes;
  const slice = truncated ? bytes.subarray(0, maxBytes) : bytes;
  return {
    content: textDecoder.decode(slice),
    truncated,
    sizeBytes: bytes.byteLength,
  };
}
