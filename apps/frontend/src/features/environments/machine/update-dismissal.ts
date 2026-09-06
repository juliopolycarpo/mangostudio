/**
 * "Dismissed until a newer version shows up" for the update banner.
 *
 * Not "dismissed forever": storing the version the reader dismissed, rather
 * than a boolean, means a later release re-opens the banner on its own. A
 * plain string comparison is enough — a re-dismiss overwrites the stored
 * value, so the only thing that ever suppresses the banner is the exact
 * version already dismissed, never an ordering question.
 */

const UPDATE_DISMISSED_KEY = 'mangostudio:update-dismissed';

export function readDismissedUpdateVersion(): string | null {
  try {
    return window.localStorage.getItem(UPDATE_DISMISSED_KEY);
  } catch {
    return null;
  }
}

export function dismissUpdateVersion(version: string): void {
  try {
    window.localStorage.setItem(UPDATE_DISMISSED_KEY, version);
  } catch {
    // Best-effort like every other panel preference: the banner just shows
    // again next time when storage is unavailable.
  }
}
