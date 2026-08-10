/**
 * Reading and comparing the version of whatever `cursor-agent` the scanner
 * resolved.
 *
 * Cursor's version is calendar-shaped — `2026.08.04-aaa8809` — which the
 * environment scanner already parses into a `SemVer` whose fields are year,
 * month and day. That parser is reused rather than reimplemented: a second
 * regex here would be a second answer to "is this build recent enough", and the
 * two would eventually disagree about the same string.
 *
 * The comparison is strict where the parse is loose. A version that cannot be
 * parsed is `null` rather than a guess, and `null` never satisfies the minimum —
 * an unknown version is the one case where both "old enough" and "new enough"
 * are wrong.
 */

import type { SemVer } from '@mangostudio/shared/environments/detection';
import { parseCursorAgentVersion } from '@mangostudio/shared/environments/detection';

/** Negative when `left` is older, zero when equal, positive when newer. */
function compareCursorVersions(left: SemVer, right: SemVer): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

/**
 * Whether an observed build may drive this adapter.
 *
 * Newer than the pin is allowed: the reducer ignores `session/update` variants
 * it does not know, so an additive protocol change degrades to something not
 * rendered rather than to a failed turn. Older is refused, because nothing
 * establishes that `cursor-agent acp` existed or answered this way before the
 * pinned build.
 */
export function isCursorVersionSupported(
  observed: SemVer | null | undefined,
  minimum: SemVer
): boolean {
  return observed != null && compareCursorVersions(observed, minimum) >= 0;
}

/** The pinned minimum, parsed once so callers compare structures rather than strings. */
export function requireCursorVersion(raw: string): SemVer {
  const parsed = parseCursorAgentVersion(raw);
  if (!parsed) throw new Error(`"${raw}" is not a parseable cursor-agent version.`);
  return parsed;
}
