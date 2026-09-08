import type { OnboardingState } from '../onboarding';
import { DEFAULT_PROFILE_ID, type ProfileId } from '../profiles';
import type { AppSettings, AppSettingsPutBody, LibraryLocationSettings } from './schemas';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Overlay a settings patch on the value already stored, one key at a time.
 *
 * The rule, in full:
 *
 * - an omitted key keeps whatever is stored;
 * - two objects merge recursively, so a patch touching one nested field leaves
 *   its siblings alone;
 * - anything that is not an object — an array, a string, a number, `null` —
 *   replaces what was there. Arrays replace deliberately: merging them by index
 *   makes "remove the second rule" inexpressible.
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
  return mergeValue(stored, patch);
}

function mergeValue(stored: unknown, patch: unknown): unknown {
  if (!isPlainRecord(patch)) return patch;
  if (!isPlainRecord(stored)) return patch;

  const merged: Record<string, unknown> = { ...stored };
  for (const [key, value] of Object.entries(patch)) {
    // `undefined` reaches here only from an in-process caller building a body
    // literal; over the wire JSON drops the key entirely. Both mean "not
    // supplied", so both must leave the stored value alone.
    if (value === undefined) continue;
    merged[key] = mergeValue(stored[key], value);
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
