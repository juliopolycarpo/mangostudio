/**
 * The observation a preview token is bound to.
 *
 * Propagation and removal are different operations with different verbs, but
 * they answer the same question before writing: *is the disk still what the
 * user reviewed?* One implementation of that hash means one thing to audit, and
 * means a removal cannot accidentally be validated against a weaker snapshot
 * than an overwrite — which is the direction the asymmetry would otherwise run,
 * since a removal's backup is the only remaining copy.
 */

import { createHash } from 'node:crypto';
import type {
  LibraryLocationId,
  LibraryLocationStatus,
  LibraryResource,
} from '@mangostudio/shared/library';

/**
 * Covers every instance and every location's observable state. An apply
 * re-derives this and refuses to run when it differs, so a file the user edited
 * in another window between the two calls is never silently clobbered.
 */
export function hashLibraryState(
  resources: readonly LibraryResource[],
  statuses: ReadonlyMap<LibraryLocationId, LibraryLocationStatus>
): string {
  return hashJson({
    resources: resources
      .map((resource) => ({
        key: resource.key,
        instances: resource.instances
          .map((instance) => ({
            locationId: instance.locationId,
            path: instance.path,
            valid: instance.valid,
            contentHash: instance.contentHash ?? null,
            sizeBytes: instance.sizeBytes ?? null,
            modifiedAtMs: instance.modifiedAtMs,
          }))
          .sort((left, right) => compareText(left.locationId, right.locationId)),
      }))
      .sort((left, right) => compareText(left.key, right.key)),
    locations: [...statuses.values()]
      .map((status) => ({
        id: status.id,
        path: status.path,
        exists: status.exists,
        writable: status.writable,
        access: status.access,
      }))
      .sort((left, right) => compareText(left.id, right.id)),
  });
}

export function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

/** Locale-independent so a token computed here matches one computed anywhere. */
export function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
