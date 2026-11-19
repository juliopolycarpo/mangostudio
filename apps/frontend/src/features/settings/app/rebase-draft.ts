import type { AppSettings } from '@mangostudio/shared/app-settings';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural equality for settings values: JSON-shaped, so no cycles or class instances. */
function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, i) => sameValue(item, right[i]));
  }
  if (isPlainRecord(left) && isPlainRecord(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].every((key) => sameValue(left[key], right[key]));
  }
  return false;
}

/**
 * Lays the fields a user edited, and has not saved yet, back over a freshly
 * fetched copy of the settings.
 *
 * Auto-save builds each edit on the cache, so a refetch that replaces the cache
 * mid-burst would otherwise throw the unsent fields away: the UI would show
 * them reverting, and the next keystroke would build its patch from the
 * fetched value alone. "Edited" means the field differs between `base` (the
 * settings the burst started from) and `draft` (where the burst has got to).
 * A field is the unit one surface owns and sends whole, so the comparison is
 * per top-level field, the same granularity as the PUT patch. Fields nobody
 * here touched keep the fetched value, which is how another tab's write to a
 * different field survives.
 *
 * `profileSettings` is never rebased: the settings screen's patch excludes it
 * (see `appSettingsPatchExcludingProfiles`), so its owner is another surface.
 *
 * @example
 * const next = rebaseAppSettingsDraft(burstStart, draft, refetched);
 */
export function rebaseAppSettingsDraft(
  base: AppSettings,
  draft: AppSettings,
  fetched: AppSettings
): AppSettings {
  const rebased: Record<string, unknown> = { ...fetched };
  for (const key of Object.keys(draft) as (keyof AppSettings)[]) {
    if (key === 'profileSettings') continue;
    if (!sameValue(base[key], draft[key])) rebased[key] = draft[key];
  }
  return rebased as unknown as AppSettings;
}
