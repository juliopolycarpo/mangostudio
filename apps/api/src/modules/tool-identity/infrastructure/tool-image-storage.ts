/**
 * Where tool avatar bytes live on disk.
 *
 * One directory per user, and a filename this module invents rather than one
 * derived from anything a user typed. A stored path is therefore never a name
 * an attacker chose, and the containment check on the way back out is a second
 * line rather than the only one.
 */

import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getConfig } from '../../../lib/config';
import { generateId } from '../../../utils/id';
import { resolveContainedPath } from '../../../utils/paths';

function toolImagesDir(): string {
  return getConfig().toolImages.dir;
}

/**
 * A fresh relative path for one image.
 *
 * The random half matters: writing to a name derived only from the subject
 * would overwrite the file a request already in flight is reading, and the old
 * bytes would be served half-replaced. A new file per write plus a delete of
 * the previous one keeps every read whole.
 */
export function buildToolImagePath(userId: string, extension: string): string {
  return join(sanitizeSegment(userId), `${generateId()}.${extension}`);
}

/** Ids are generated, but they end up in a path, so they are still narrowed. */
function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '') || 'unknown';
}

/** Absolute path for a stored image, or null if the row points outside the root. */
function resolveToolImagePath(relativePath: string): string | null {
  return resolveContainedPath(toolImagesDir(), relativePath);
}

export async function writeToolImage(relativePath: string, bytes: Uint8Array): Promise<void> {
  const absolutePath = resolveToolImagePath(relativePath);
  if (!absolutePath) {
    throw new Error('Refusing to write a tool image outside its directory.');
  }
  await mkdir(dirname(absolutePath), { recursive: true });
  await Bun.write(absolutePath, bytes);
}

/**
 * Removes a replaced or reset image. A missing file is the expected outcome
 * after a partially failed write, so it is not an error worth surfacing to a
 * user who only asked to change their avatar.
 */
export async function deleteToolImage(relativePath: string | null): Promise<void> {
  if (!relativePath) return;
  const absolutePath = resolveToolImagePath(relativePath);
  if (!absolutePath) return;
  await rm(absolutePath, { force: true }).catch(() => undefined);
}

/** The stored file, or null when the row points at something that is gone. */
export async function readToolImage(relativePath: string): Promise<Blob | null> {
  const absolutePath = resolveToolImagePath(relativePath);
  if (!absolutePath) return null;

  const file = Bun.file(absolutePath);
  return (await file.exists()) ? file : null;
}
