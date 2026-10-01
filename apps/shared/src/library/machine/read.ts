/**
 * Where a library resource's content lives, and how much of it a detail view
 * reads. The hub resolves the path here and asks the runtime that owns the
 * machine for the bytes, contained to the location's root on that machine.
 */

import { posix, win32 } from 'node:path';
import type { LibraryHashPathStyle } from '../hash';
import type { ResourceKind } from '../index';
import { SKILL_ENTRYPOINT } from './instance-reader';

/** Default ceiling for a detail-view content read (hub passes its own when different). */
export const MAX_LIBRARY_CONTENT_BYTES = 512 * 1024;

/**
 * Builds the absolute content path for a resource instance. Skills are
 * directories; everything else is a single file at the instance path.
 *
 * The runtime that owns the library evaluates the result, so the join uses
 * that machine's `pathStyle` (from its manifest), never the hub's `node:path`
 * flavour: a Windows hub reading a POSIX runtime must still send `/`, and a
 * POSIX hub reading a Windows runtime must send `\`.
 *
 * @example
 * libraryContentPath('skill', '/home/me/.mango/skills/gh', 'posix');
 * // '/home/me/.mango/skills/gh/SKILL.md'
 */
export function libraryContentPath(
  kind: ResourceKind,
  instancePath: string,
  pathStyle: LibraryHashPathStyle
): string {
  if (kind !== 'skill') return instancePath;
  const pathApi = pathStyle === 'win32' ? win32 : posix;
  return pathApi.join(instancePath, SKILL_ENTRYPOINT);
}
