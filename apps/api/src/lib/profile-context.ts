import { DEFAULT_PROFILE_ID, type ProfileId } from '@mangostudio/shared/profiles';

export interface ProfileRequestContext {
  readonly userId: string;
}

export class ProfileMismatchError extends Error {
  constructor(
    readonly requested: string,
    readonly active: ProfileId
  ) {
    super(`Requested profile "${requested}" does not match the active profile "${active}".`);
    this.name = 'ProfileMismatchError';
  }
}

/**
 * Resolve the active profile. Always DEFAULT_PROFILE_ID until profiles ship.
 * Call this from every read and write path that will eventually be
 * profile-scoped so implementing profiles means changing one function body.
 */
export function resolveActiveProfileId(_context: ProfileRequestContext): ProfileId {
  return DEFAULT_PROFILE_ID;
}

/**
 * Accept an optional client-supplied profileId. A present id that does not
 * match the active profile is rejected — silently discarding a client's scope
 * would leak one profile's state into another.
 */
export function assertRequestedProfileId(
  requested: string | undefined,
  context: ProfileRequestContext
): ProfileId {
  const active = resolveActiveProfileId(context);
  if (requested !== undefined && requested !== active) {
    throw new ProfileMismatchError(requested, active);
  }
  return active;
}
