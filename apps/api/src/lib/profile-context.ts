import { DEFAULT_PROFILE_ID, type ProfileId } from '@mangostudio/shared/profiles';

export interface ProfileRequestContext {
  readonly userId: string;
}

/**
 * Resolve the active profile. Always DEFAULT_PROFILE_ID until profiles ship.
 * Call this from every read and write path that will eventually be
 * profile-scoped so implementing profiles means changing one function body.
 */
export function resolveActiveProfileId(_context: ProfileRequestContext): ProfileId {
  return DEFAULT_PROFILE_ID;
}
