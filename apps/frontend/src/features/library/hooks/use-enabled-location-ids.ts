/**
 * The home-scope locations the scanner reads, for surfaces that must not offer
 * one it skips.
 *
 * Undefined means "not known yet", never "nothing is enabled": the settings
 * answer is missing on first load, and while the hub is still detecting
 * installed agent CLIs the enablement it carries is a placeholder. A caller that
 * narrows by this set should leave its list whole until the answer is real.
 *
 * // Usage: const enabled = useEnabledLocationIds();
 */

import { libraryLocationsFor } from '@mangostudio/shared/app-settings';
import type { LibraryLocationId } from '@mangostudio/shared/library';
import { enabledLibraryLocations } from '@mangostudio/shared/library/values';
import { useMemo } from 'react';

import { useLibraryDefaultsDetection } from '@/features/settings/app/use-library-defaults-detection';

export function useEnabledLocationIds(): ReadonlySet<LibraryLocationId> | undefined {
  const { settings, defaultsPending } = useLibraryDefaultsDetection();

  return useMemo(() => {
    if (!settings || defaultsPending) return undefined;
    // No workspace-scoped location exists, so every location is home.
    return enabledLibraryLocations(libraryLocationsFor(settings), 'home');
  }, [settings, defaultsPending]);
}
