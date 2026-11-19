import type { OnboardingState } from '../onboarding';
import { DEFAULT_PROFILE_ID, type ProfileId } from '../profiles';
import type { AppSettings, AppSettingsPutBody, LibraryLocationSettings } from './schemas';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Overlay a settings patch on the value already stored, one owned field at a
 * time.
 *
 * The rule, in full:
 *
 * - an omitted key keeps whatever is stored;
 * - a supplied field replaces what was stored under it, whole. A field is the
 *   unit one surface owns and sends complete, so merging into it would make an
 *   optional member the patch deliberately left out — "no folder chosen yet" —
 *   indistinguishable from one it never mentioned, and a clear inexpressible.
 *   Arrays replace for the same reason: merging by index makes "remove the
 *   second rule" unsayable;
 * - the containers *above* those fields do merge, because their children have
 *   different owners: `profileSettings` holds one entry per profile, and each
 *   entry holds `libraryLocations` and `onboarding`, written by different
 *   screens. That is the whole reason this is a merge rather than an overwrite.
 *
 * The result is raw, untrusted shape, exactly like the row it came from.
 * `normalizeAppSettings` is what turns it back into settings; running it after
 * the merge rather than before is what lets `null` mean "back to the default".
 *
 * @example
 * mergeAppSettingsPatch({ thinkingEnabled: true, reasoningEffort: 'high' }, { thinkingEnabled: false });
 * // => { thinkingEnabled: false, reasoningEffort: 'high' }
 */
export function mergeAppSettingsPatch(stored: unknown, patch: AppSettingsPutBody): unknown {
  return mergeValue(stored, patch, []);
}

/**
 * Take the server-owned fields out of a client patch, keeping what is stored.
 *
 * `externalAgentSettings.workspaceTrust` is written only by the trust and
 * revoke endpoints: they derive the canonical path on the runtime and stamp the
 * current trust-text version, which a settings body can do neither of. A client
 * that echoes the whole settings object still sends the field, so it is not
 * rejected — its value is replaced by the stored one. `externalAgentSettings`
 * is a unit that replaces whole (see `mergeAppSettingsPatch`), so merely
 * deleting the key from the patch would wipe the stored grants instead.
 *
 * A patch that omits `externalAgentSettings` is returned as is: omission
 * already keeps what is stored.
 *
 * @example
 * const safe = preserveServerOwnedSettings(storedRow, bodyFromClient);
 */
export function preserveServerOwnedSettings(
  stored: unknown,
  patch: AppSettingsPutBody
): AppSettingsPutBody {
  if (patch.externalAgentSettings === undefined) return patch;
  const storedAgents = isPlainRecord(stored) ? stored.externalAgentSettings : undefined;
  const { workspaceTrust: _clientTrust, ...clientOwned } = patch.externalAgentSettings;
  const storedTrust = isPlainRecord(storedAgents) ? storedAgents.workspaceTrust : undefined;
  // Left undefined when nothing valid is stored, so normalization yields the
  // empty list instead of a client-chosen one. The cast is the raw-row
  // boundary: whatever is stored is normalized after the merge, as always.
  return {
    ...patch,
    externalAgentSettings: {
      ...clientOwned,
      workspaceTrust: storedTrust as AppSettings['externalAgentSettings']['workspaceTrust'],
    },
  };
}

/**
 * Whether the value at this path holds children with separate owners, and so has
 * to merge rather than replace.
 *
 * Exactly three do: the settings object itself, the profile map, and one
 * profile's entry. Everything below is a field its one writer sends whole.
 */
function mergesChildren(path: readonly string[]): boolean {
  if (path.length === 0) return true;
  return path[0] === 'profileSettings' && path.length <= 2;
}

function mergeValue(stored: unknown, patch: unknown, path: readonly string[]): unknown {
  if (!mergesChildren(path)) return patch;
  if (!isPlainRecord(patch)) return patch;
  if (!isPlainRecord(stored)) return patch;

  const merged: Record<string, unknown> = { ...stored };
  for (const [key, value] of Object.entries(patch)) {
    // `undefined` reaches here only from an in-process caller building a body
    // literal; over the wire JSON drops the key entirely. Both mean "not
    // supplied", so both must leave the stored value alone.
    if (value === undefined) continue;
    merged[key] = mergeValue(stored[key], value, [...path, key]);
  }
  return merged;
}

/**
 * Address just this profile's library locations.
 *
 * A caller that toggles one location has no business carrying the rest of the
 * settings object with it; sending this instead means a concurrent edit to an
 * unrelated preference survives.
 *
 * @example
 * await put(libraryLocationsPatch({ ...locations, home: { ...locations.home, 'claude-skills': true } }));
 */
export function libraryLocationsPatch(
  libraryLocations: LibraryLocationSettings,
  profileId: ProfileId = DEFAULT_PROFILE_ID
): AppSettingsPutBody {
  return { profileSettings: { [profileId]: { libraryLocations } } };
}

/**
 * Address just this profile's first-run progress. `null` resets it.
 *
 * @example
 * await put(onboardingPatch({ ...progress, completedAt: Date.now() }));
 */
export function onboardingPatch(
  onboarding: OnboardingState | null,
  profileId: ProfileId = DEFAULT_PROFILE_ID
): AppSettingsPutBody {
  return { profileSettings: { [profileId]: { onboarding } } };
}

/**
 * Everything a settings *screen* owns, and nothing a wizard or a library
 * toggle owns.
 *
 * The settings surface auto-saves a whole snapshot it read at mount. Left
 * as-is that snapshot would carry a stale `profileSettings` — the tab that was
 * open while someone finished onboarding in another one would quietly reset
 * their progress on the next keystroke. Dropping the key entirely is what makes
 * that impossible rather than merely unlikely.
 *
 * @example
 * mutate(appSettingsPatchExcludingProfiles(nextSettings));
 */
export function appSettingsPatchExcludingProfiles(settings: AppSettings): AppSettingsPutBody {
  const { profileSettings: _profileSettings, ...rest } = settings;
  return rest;
}
