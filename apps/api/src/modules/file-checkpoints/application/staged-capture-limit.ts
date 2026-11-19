/**
 * How large a file one more checkpoint of an assistant message may hold.
 *
 * A revert uploads every staged-size blob of the message to the runtime before
 * it writes the first file, because that is what lets the runtime validate the
 * whole set up front and refuse a bad one with nothing changed. The runtime's
 * staging area is bounded (2 GiB, 256 files), so a message whose blobs together
 * outgrow it could be captured but never reverted. Batching the uploads would
 * lift that, at the cost of the all-or-nothing property: a failure in the second
 * batch would leave the first already written. So the bound sits on capture
 * instead: past the message's byte or blob budget, the next capture is limited
 * to inline-size files, and a bigger file is refused before the mutation runs,
 * the same way a file past `checkpoints.max_file_bytes` is.
 *
 * The budget is read from rows already stored, so tool calls of one message that
 * capture at the same moment each see the same remaining budget. The runtime's
 * staging bounds still refuse an upload that does not fit, and a revert that
 * hits them fails before it changes anything.
 */

import {
  SNAPSHOT_INLINE_MAX_BYTES,
  SNAPSHOT_MESSAGE_STAGED_MAX_BLOBS,
  SNAPSHOT_MESSAGE_STAGED_MAX_BYTES,
} from '@mangostudio/shared/runtime-contract';
import type { Kysely } from 'kysely';

import type { Database } from '../../../db/types';
import { checkpointBlobSize } from '../infrastructure/checkpoint-blob-store';
import { listActiveCheckpointsForMessage } from '../infrastructure/checkpoint-repository';

/** What a message's revertable checkpoints already hold in staged-size blobs. */
export interface StagedUsage {
  readonly blobs: number;
  readonly bytes: number;
}

/**
 * Largest file the next capture of a message may hold: `maxFileBytes` while the
 * message has budget left, shrinking to the remaining bytes, and to inline size
 * once the bytes or the blob count are spent. Inline-size files always fit.
 *
 * // Usage: snapshotMaxBytes = stagedCaptureLimit(config.checkpoints.maxFileBytes, usage)
 */
export function stagedCaptureLimit(maxFileBytes: number, used: StagedUsage): number {
  const blobsLeft = used.blobs < SNAPSHOT_MESSAGE_STAGED_MAX_BLOBS;
  const bytesLeft = Math.max(0, SNAPSHOT_MESSAGE_STAGED_MAX_BYTES - used.bytes);
  const stagedLimit = blobsLeft ? bytesLeft : 0;
  return Math.min(maxFileBytes, Math.max(SNAPSHOT_INLINE_MAX_BYTES, stagedLimit));
}

/**
 * Staged-size blobs the message's revertable rows reference. Rows that share
 * content share one blob, and the revert uploads it once per row, so a blob
 * counts once per row that restores it.
 */
export async function messageStagedUsage(
  db: Kysely<Database>,
  chatId: string,
  messageId: string
): Promise<StagedUsage> {
  const rows = await listActiveCheckpointsForMessage(db, chatId, messageId);
  let blobs = 0;
  let bytes = 0;
  for (const row of rows) {
    if (row.blobKey === null) continue;
    const size = checkpointBlobSize(row.blobKey);
    if (size <= SNAPSHOT_INLINE_MAX_BYTES) continue;
    blobs += 1;
    bytes += size;
  }
  return { blobs, bytes };
}
