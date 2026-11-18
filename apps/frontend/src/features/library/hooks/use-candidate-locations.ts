/**
 * The destinations a propagation preview is asked about, for one resource kind.
 *
 * Every location of the kind is a candidate, enabled or not: the API reports a
 * disabled one as a blocked destination and the wizard shows why. The answer
 * still waits for app settings, though. The API decides what is disabled from
 * them, and while the hub is still detecting installed agent CLIs that
 * enablement is a placeholder, so a preview taken then would call locations
 * disabled that the user has not switched off. The answer stays unresolved
 * until detection lands.
 *
 * // Usage: const candidates = useCandidateLocations(locations, 'skill');
 */

import type {
  LibraryLocationId,
  LibraryLocationStatus,
  ResourceKind,
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
  const settingsLoaded = appSettings !== undefined;

  return useMemo(() => {
    if (defaultsPending) return DETECTING;
    if (kind === undefined || !settingsLoaded) return UNRESOLVED;

    return {
      locationIds: propagationCandidateLocationIds(locations, kind),
      isResolved: true,
      isDetecting: false,
    };
  }, [locations, kind, settingsLoaded, defaultsPending]);
}
