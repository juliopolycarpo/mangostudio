/**
 * Reading a persisted permission choice back.
 *
 * The API shape is a closed union — a TypeBox union of literals validates
 * nothing else, and that is deliberate: widening it later is a decision, not a
 * default. The database columns that hold a user's choice are `TEXT` and
 * forward-compatible, so a build that once wrote a wider value and was then
 * rolled back leaves rows this build does not recognize.
 *
 * The read path resolves that disagreement one way only: **towards the
 * restrictive end**. An unrecognized level reads as `read-only` and an
 * unrecognized routing reads as `user`, because the failure mode worth
 * preventing is a downgrade silently granting an agent more freedom than the
 * user ever chose. The `recognized` flag exists so the caller can log a
 * diagnostic instead of the substitution passing unremarked.
 */

import {
  EXTERNAL_APPROVAL_ROUTINGS,
  EXTERNAL_PERMISSION_LEVELS,
  type ExternalApprovalRouting,
  type ExternalPermissionLevel,
} from './schemas';

/** The value to use, plus whether it is the one that was stored. */
export interface NormalizedPermissionValue<T> {
  readonly value: T;
  /** False when the stored value was unrecognized and the restrictive default was substituted. */
  readonly recognized: boolean;
}

/** The most restrictive level. What an unrecognized stored value reads as. */
export const RESTRICTIVE_PERMISSION_LEVEL: ExternalPermissionLevel = 'read-only';

/** The routing that always asks a human. What an unrecognized stored value reads as. */
export const RESTRICTIVE_APPROVAL_ROUTING: ExternalApprovalRouting = 'user';

export function normalizePermissionLevel(
  stored: string | null | undefined
): NormalizedPermissionValue<ExternalPermissionLevel> {
  const match = EXTERNAL_PERMISSION_LEVELS.find((level) => level === stored);
  return match
    ? { value: match, recognized: true }
    : { value: RESTRICTIVE_PERMISSION_LEVEL, recognized: false };
}

export function normalizeApprovalRouting(
  stored: string | null | undefined
): NormalizedPermissionValue<ExternalApprovalRouting> {
  const match = EXTERNAL_APPROVAL_ROUTINGS.find((routing) => routing === stored);
  return match
    ? { value: match, recognized: true }
    : { value: RESTRICTIVE_APPROVAL_ROUTING, recognized: false };
}
