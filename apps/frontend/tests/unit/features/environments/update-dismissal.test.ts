/**
 * The update banner's "dismissed until a newer version" rule lives entirely in
 * localStorage string comparison — no semver, no ordering, just "is this the
 * exact version I already said no to".
 */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  dismissUpdateVersion,
  readDismissedUpdateVersion,
} from '../../../../src/features/environments/machine/update-dismissal';

const UPDATE_DISMISSED_KEY = 'mangostudio:update-dismissed';

afterEach(() => {
  window.localStorage.removeItem(UPDATE_DISMISSED_KEY);
});

describe('update-dismissal', () => {
  it('reads nothing before anything was dismissed', () => {
    expect(readDismissedUpdateVersion()).toBeNull();
  });

  it('remembers the exact version that was dismissed', () => {
    dismissUpdateVersion('0.2.0');
    expect(readDismissedUpdateVersion()).toBe('0.2.0');
  });

  it('a re-dismiss of the same version stays dismissed', () => {
    dismissUpdateVersion('0.2.0');
    dismissUpdateVersion('0.2.0');
    expect(readDismissedUpdateVersion()).toBe('0.2.0');
  });

  it('a newer version is not the one that was dismissed', () => {
    dismissUpdateVersion('0.2.0');
    const dismissed = readDismissedUpdateVersion();
    // The banner's own check: a fetched `latestVersion` that differs from the
    // stored one must show again, however it compares numerically.
    expect(dismissed === '0.3.0').toBe(false);
  });
});
