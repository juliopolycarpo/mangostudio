/**
 * The destinations a propagation preview may name, for one resource kind.
 *
 * Both propagation openers — the matrix bulk action and the resource detail —
 * need the same answer, and both need it to be *known* before they offer the
 * action: the enabled-location set lives in app settings, and treating "not
 * loaded yet" as "nothing is enabled" would silently drop every destination
 * outside MangoStudio's own directories, which `enabledLibraryLocations` always
 * keeps on. An empty list therefore means "no enabled destination", never "the
 * answer has not arrived".
 *
 * // Usage: const locationIds = useCandidateLocationIds(locations, 'skill');
 */

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

export function useCandidateLocationIds(
  locations: readonly LibraryLocationStatus[],
  kind: ResourceKind | undefined
): LibraryLocationId[] {
  const libraryLocations = useQuery(appSettingsQueryOptions()).data?.libraryLocations;

  return useMemo(() => {
    if (kind === undefined || libraryLocations === undefined) return [];
    return propagationCandidateLocationIds(
      locations,
      kind,
      enabledLibraryLocations(libraryLocations)
    );
  }, [locations, kind, libraryLocations]);
}
