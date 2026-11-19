import type { Kysely } from 'kysely';

import type { Database } from '../../../db/types';
import { createDiagnosticLogger } from '../../../lib/logger';
import {
  deleteStoredGeneratedImage,
  listStoredGeneratedImages,
} from '../../../services/generated-images/generated-image-storage';
import { listReferencedGeneratedImageFilenames } from '../infrastructure/generated-image-repository';

/**
 * How old an unreferenced file must be before a sweep removes it. A turn writes
 * the file when the provider answers but only records it when the turn ends, so
 * anything younger than this may still belong to a turn in flight.
 */
export const UNREFERENCED_IMAGE_GRACE_MS = 24 * 60 * 60 * 1000;

const logger = createDiagnosticLogger('generated-image-reclaim');

async function removeFiles(filenames: Iterable<string>): Promise<number> {
  let removed = 0;
  for (const filename of filenames) {
    try {
      if (await deleteStoredGeneratedImage(filename)) removed += 1;
    } catch (error) {
      // One stuck file must not keep the rest on disk; the next sweep retries it.
      logger.error('remove_failed', {
        filename,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return removed;
}

/** File names the chat's rows point at, to read before the chat is deleted. */
export async function listChatGeneratedImageFilenames(
  db: Kysely<Database>,
  chatId: string
): Promise<Set<string>> {
  return listReferencedGeneratedImageFilenames(db, { chatId });
}

/**
 * Removes the given image files unless a stored row still points at them.
 * Call it after the rows that referenced them are gone: while they exist every
 * file looks wanted.
 *
 * @returns how many files were removed
 * @example
 * const filenames = await listChatGeneratedImageFilenames(db, chatId);
 * await deleteChat(chatId, userId, db);
 * await releaseGeneratedImageFiles(db, filenames);
 */
export async function releaseGeneratedImageFiles(
  db: Kysely<Database>,
  filenames: ReadonlySet<string>
): Promise<number> {
  if (filenames.size === 0) return 0;

  const stillReferenced = await listReferencedGeneratedImageFilenames(db);
  return removeFiles([...filenames].filter((filename) => !stillReferenced.has(filename)));
}

export interface SweepOptions {
  /** Clock for the age check; defaults to the current time. */
  now?: number;
  graceMs?: number;
}

/**
 * Removes generated image files that no row references and that are older than
 * the grace period: orphans from a timeout, a crash, or a user deleted with
 * their chats.
 *
 * @returns how many files were removed
 */
export async function sweepUnreferencedGeneratedImages(
  db: Kysely<Database>,
  options: SweepOptions = {}
): Promise<number> {
  const cutoff = (options.now ?? Date.now()) - (options.graceMs ?? UNREFERENCED_IMAGE_GRACE_MS);

  // Listed before the references are read: a file written in between is absent
  // from this list, so it can never be judged against rows that predate it.
  const oldFiles = (await listStoredGeneratedImages()).filter((file) => file.modifiedAtMs < cutoff);
  if (oldFiles.length === 0) return 0;

  const referenced = await listReferencedGeneratedImageFilenames(db);
  const removed = await removeFiles(
    oldFiles.map((file) => file.filename).filter((filename) => !referenced.has(filename))
  );
  if (removed > 0) logger.info('swept', { removed });
  return removed;
}
