/**
 * Contained library content reads. A path is only readable when it sits inside
 * one of the registered location roots the hub named for this request — the
 * same containment idea as workspace file ops, applied to agent homes.
 */

import { open, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { LibraryLocationId, ResourceKind } from '@mangostudio/shared/library';
import { getLibraryLocation } from '@mangostudio/shared/library/host';
import type { PathEnv } from '@mangostudio/shared/runtime-env';
import { RuntimeToolArgumentError } from '../../errors';
import { isPathWithin, SKILL_ENTRYPOINT } from './instance-reader';

/** Default ceiling for a detail-view content read (hub passes its own when different). */
export const MAX_LIBRARY_CONTENT_BYTES = 512 * 1024;

export interface LibraryReadParams {
  /** Absolute path of the file to read (skill entrypoints are already joined). */
  readonly path: string;
  /**
   * Absolute root of the location the path must sit inside, resolved on this
   * host from its own `PathEnv`.
   */
  readonly root: string;
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

/**
 * Builds the absolute content path for a resource instance. Skills are
 * directories; everything else is a single file at the instance path.
 */
export function libraryContentPath(kind: ResourceKind, instancePath: string): string {
  return kind === 'skill' ? join(instancePath, SKILL_ENTRYPOINT) : instancePath;
}

/**
 * Directory a read for this location may not leave, resolved from this host's
 * own `PathEnv`.
 *
 * A `single-file` location resolves to the file itself, and a file cannot
 * contain anything — checking a read against it would accept whatever that name
 * happens to point at, which is how a symlinked `CLAUDE.md` becomes a read of
 * `/etc/passwd`. The enclosing agent home is the real boundary, so that is what
 * single-file layouts are checked against; directory layouts are their own root.
 *
 * Null when the location cannot exist here — unsupported platform, or a scope
 * whose root this `PathEnv` does not carry.
 */
export function libraryLocationRoot(locationId: LibraryLocationId, env: PathEnv): string | null {
  const location = getLibraryLocation(locationId);
  if (!location) return null;
  const path = location.resolvePath(env);
  if (path === null) return null;
  return location.layout === 'single-file' ? dirname(path) : path;
}

/**
 * Open once, fstat the descriptor, and read at most `maxBytes` — never load the
 * whole file only to throw or truncate afterward.
 */
async function readBoundedCanonical(
  canonicalPath: string,
  maxBytes: number,
  truncateOversize: boolean,
  displayName: string
): Promise<LibraryReadResult> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(canonicalPath, 'r');
  } catch {
    throw new LibraryReadDeniedError(`Library path "${displayName}" is not readable.`);
  }

  try {
    const meta = await handle.stat();
    if (!meta.isFile()) {
      throw new LibraryReadDeniedError(`Library path "${displayName}" is not a regular file.`);
    }

    const sizeBytes = meta.size;
    const shouldTruncate = sizeBytes > maxBytes;
    if (shouldTruncate && !truncateOversize) {
      throw new LibraryReadDeniedError(
        `Library file "${displayName}" exceeds the ${maxBytes} byte cap.`
      );
    }

    const limit = shouldTruncate ? maxBytes : sizeBytes;
    if (limit === 0) {
      return { content: '', truncated: shouldTruncate, sizeBytes };
    }

    const buffer = Buffer.alloc(limit);
    let offset = 0;
    while (offset < limit) {
      const { bytesRead } = await handle.read(buffer, offset, limit - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return {
      content: textDecoder.decode(buffer.subarray(0, offset)),
      truncated: shouldTruncate,
      sizeBytes,
    };
  } finally {
    await handle.close();
  }
}

/**
 * `realPath` is the only seam a caller can swap: the bytes are read from the
 * open descriptor of the path this resolves to, so faking anything below it
 * would mean the containment check no longer described the read.
 */
export async function readLibraryContent(
  params: LibraryReadParams,
  realPath: (path: string) => Promise<string> = realpath
): Promise<LibraryReadResult> {
  if (typeof params.path !== 'string' || params.path.length === 0) {
    throw new RuntimeToolArgumentError('library.read requires a non-empty path.');
  }
  if (typeof params.root !== 'string' || params.root.length === 0) {
    throw new RuntimeToolArgumentError('library.read requires a location root.');
  }
  const maxBytes = params.maxBytes ?? MAX_LIBRARY_CONTENT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RuntimeToolArgumentError('library.read requires a positive integer maxBytes.');
  }
  const cappedMaxBytes = Math.min(maxBytes, MAX_LIBRARY_CONTENT_BYTES);

  let canonicalPath: string;
  try {
    canonicalPath = await realPath(params.path);
  } catch {
    throw new LibraryReadDeniedError(`Library path "${params.path}" is not readable.`);
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await realPath(params.root);
  } catch {
    // A root that does not resolve cannot contain anything.
    throw new LibraryReadDeniedError(
      `Library path "${params.path}" is outside its registered location.`
    );
  }
  if (!isPathWithin(canonicalRoot, canonicalPath)) {
    throw new LibraryReadDeniedError(
      `Library path "${params.path}" is outside its registered location.`
    );
  }

  // Read the contained realpath, not the caller-supplied path: a symlink swap
  // between the check and the open would otherwise escape containment.
  return readBoundedCanonical(
    canonicalPath,
    cappedMaxBytes,
    params.truncateOversize === true,
    basename(params.path)
  );
}
