/**
 * The destinations a propagation preview may name, for one resource kind.
 *
 * Both propagation openers — the matrix bulk action and the resource detail —
 * need the same answer, and both need to tell "there is nothing to offer" apart
 * from "the answer has not arrived": the enabled-location set lives in app
 * settings, and treating "not loaded yet" as "nothing is enabled" would
 * silently drop every destination outside MangoStudio's own directories, which
 * `enabledLibraryLocations` always keeps on. The same holds while the hub is
 * still detecting installed agent CLIs: the enablement it answers with then is
 * a placeholder, so the answer stays unresolved until detection lands.
 *
 * // Usage: const candidates = useCandidateLocations(locations, 'skill');
 */

import { libraryLocationsFor } from '@mangostudio/shared/app-settings';
import {
  enabledLibraryLocations,
  type LibraryLocationId,
  type LibraryLocationStatus,
  type ResourceKind,
} from '@mangostudio/shared/library';
import { useMemo } from 'react';
import { useLibraryDefaultsDetection } from '@/features/settings/app/use-library-defaults-detection';
import { propagationCandidateLocationIds } from '../format';

export interface CandidateLocations {
  /** Empty only once `isResolved`, and then it means there is no destination. */
  readonly locationIds: LibraryLocationId[];
  /** False while the settings record the answer depends on is still missing. */
  readonly isResolved: boolean;
  /** True while unresolved only because the hub is detecting installed agent CLIs. */
  readonly isDetecting: boolean;
}

const UNRESOLVED: CandidateLocations = { locationIds: [], isResolved: false, isDetecting: false };
const DETECTING: CandidateLocations = { locationIds: [], isResolved: false, isDetecting: true };

export function useCandidateLocations(
  locations: readonly LibraryLocationStatus[],
  kind: ResourceKind | undefined
): CandidateLocations {
  const { settings: appSettings, defaultsPending } = useLibraryDefaultsDetection();
  const libraryLocations = appSettings ? libraryLocationsFor(appSettings) : undefined;

  return useMemo(() => {
    if (defaultsPending) return DETECTING;
    if (kind === undefined || libraryLocations === undefined) return UNRESOLVED;

    return {
      locationIds: propagationCandidateLocationIds(
        locations,
        kind,
        // No workspace-scoped location exists, so every candidate is home.
        enabledLibraryLocations(libraryLocations, 'home')
      ),
      isResolved: true,
      isDetecting: false,
    };
  }, [locations, kind, libraryLocations, defaultsPending]);
}
