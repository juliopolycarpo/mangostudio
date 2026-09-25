/**
 * Where a library resource's content lives, and how much of it a detail view
 * reads. The hub resolves the path here and asks the runtime that owns the
 * machine for the bytes, contained to the location's root on that machine.
 */

import { join } from 'node:path';
import type { ResourceKind } from '../index';
import { SKILL_ENTRYPOINT } from './instance-reader';

/** Default ceiling for a detail-view content read (hub passes its own when different). */
export const MAX_LIBRARY_CONTENT_BYTES = 512 * 1024;

/**
 * Builds the absolute content path for a resource instance. Skills are
 * directories; everything else is a single file at the instance path.
 */
export function libraryContentPath(kind: ResourceKind, instancePath: string): string {
  return kind === 'skill' ? join(instancePath, SKILL_ENTRYPOINT) : instancePath;
}
