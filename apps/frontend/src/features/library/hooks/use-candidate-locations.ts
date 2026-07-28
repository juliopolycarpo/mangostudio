/**
 * The destinations a propagation preview may name, for one resource kind.
 *
 * Both propagation openers — the matrix bulk action and the resource detail —
 * need the same answer, and both need to tell "there is nothing to offer" apart
 * from "the answer has not arrived": the enabled-location set lives in app
 * settings, and treating "not loaded yet" as "nothing is enabled" would
 * silently drop every destination outside MangoStudio's own directories, which
 * `enabledLibraryLocations` always keeps on.
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
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { appSettingsQueryOptions } from '@/features/settings/app/queries';
import { propagationCandidateLocationIds } from '../format';

export interface CandidateLocations {
  /** Empty only once `isResolved`, and then it means there is no destination. */
  readonly locationIds: LibraryLocationId[];
  /** False while the settings record the answer depends on is still missing. */
  readonly isResolved: boolean;
}

const UNRESOLVED: CandidateLocations = { locationIds: [], isResolved: false };

export function useCandidateLocations(
  locations: readonly LibraryLocationStatus[],
  kind: ResourceKind | undefined
): CandidateLocations {
  const appSettings = useQuery(appSettingsQueryOptions()).data;
  const libraryLocations = appSettings ? libraryLocationsFor(appSettings) : undefined;

  return useMemo(() => {
    if (kind === undefined || libraryLocations === undefined) return UNRESOLVED;

    return {
      locationIds: propagationCandidateLocationIds(
        locations,
        kind,
        enabledLibraryLocations(libraryLocations)
      ),
      isResolved: true,
    };
  }, [locations, kind, libraryLocations]);
}
