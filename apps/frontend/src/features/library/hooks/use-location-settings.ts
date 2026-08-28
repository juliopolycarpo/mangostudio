/**
 * Which library locations the scanner is allowed to read, and the toggle that
 * changes that.
 *
 * Enablement is one app-settings record shared by every machine, while the
 * status beside each row — does the directory exist, how many entries, is it
 * writable — is read off the environment being viewed. The page keeps them
 * apart on purpose: turning a location off stops it being scanned everywhere,
 * and a switch that looked machine-local would be a promise nothing keeps.
 *
 * // Usage: const { groups, setEnabled } = useLocationSettings(environmentId);
 */

import {
  type AppSettings,
  DEFAULT_APP_SETTINGS,
  libraryLocationsFor,
  normalizeAppSettings,
  withLibraryLocations,
} from '@mangostudio/shared/app-settings';
import {
  ALWAYS_ENABLED_LIBRARY_LOCATIONS,
  enabledLibraryLocations,
  type LibraryLocationId,
  type LibraryLocationStatus,
  type ResourceKind,
} from '@mangostudio/shared/library';
import { DEFAULT_PROFILE_ID } from '@mangostudio/shared/profiles';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { updateAppSettings } from '@/features/settings/app/api';
import { appSettingsKeys, appSettingsQueryOptions } from '@/features/settings/app/queries';
import { libraryKeys, libraryLocationsQueryOptions } from '../queries';

export interface LocationSetting {
  readonly status: LibraryLocationStatus;
  readonly enabled: boolean;
  /**
   * True for MangoStudio's own directories, which the normalizer forces on.
   * Rendered as a fixed state rather than hidden: a row that vanished would
   * read as "not scanned" for the one location that always is.
   */
  readonly locked: boolean;
}

interface LocationSettingGroup {
  readonly kind: ResourceKind;
  readonly locations: readonly LocationSetting[];
}

export interface LocationSettingsState {
  readonly groups: readonly LocationSettingGroup[];
  readonly isPending: boolean;
  readonly error: unknown;
  readonly isSaving: boolean;
  readonly setEnabled: (locationId: LibraryLocationId, enabled: boolean) => void;
  readonly refetch: () => void;
}

const LOCKED_LOCATIONS: ReadonlySet<LibraryLocationId> = new Set(ALWAYS_ENABLED_LIBRARY_LOCATIONS);

export function useLocationSettings(environmentId?: string): LocationSettingsState {
  const queryClient = useQueryClient();
  const [locationsQuery, settingsQuery] = useQueries({
    queries: [libraryLocationsQueryOptions(environmentId), appSettingsQueryOptions()],
  });

  const save = useMutation({
    mutationFn: async ({
      locationId,
      enabled,
    }: {
      locationId: LibraryLocationId;
      enabled: boolean;
    }) => {
      const cached =
        queryClient.getQueryData<AppSettings>(appSettingsKeys.current()) ??
        (await queryClient.fetchQuery(appSettingsQueryOptions())) ??
        DEFAULT_APP_SETTINGS;
      const current = normalizeAppSettings(cached);
      const locations = libraryLocationsFor(current);
      return updateAppSettings(
        withLibraryLocations(current, DEFAULT_PROFILE_ID, {
          ...locations,
          // Every location defined today is home-scoped; the workspace map is
          // carried through untouched rather than rebuilt from nothing.
          home: { ...locations.home, [locationId]: enabled },
        })
      );
    },
    onSuccess: async (saved) => {
      queryClient.setQueryData(appSettingsKeys.current(), normalizeAppSettings(saved));
      // The scan answer changes with the enabled set, so every matrix built on
      // the old one is stale the moment this lands.
      await queryClient.invalidateQueries({ queryKey: libraryKeys.all });
    },
  });

  const groups = useMemo(() => {
    const statuses = locationsQuery.data ?? [];
    const settings = settingsQuery.data;
    if (settings === undefined) return [];
    const enabled = enabledLibraryLocations(libraryLocationsFor(settings), 'home');
    return groupByKind(statuses, enabled);
  }, [locationsQuery.data, settingsQuery.data]);

  return {
    groups,
    isPending: locationsQuery.isPending || settingsQuery.isPending,
    error: locationsQuery.error ?? settingsQuery.error,
    isSaving: save.isPending,
    setEnabled: (locationId, enabled) => save.mutate({ locationId, enabled }),
    refetch: () => {
      void locationsQuery.refetch();
      void settingsQuery.refetch();
    },
  };
}

/**
 * One group per kind, in the order the registry reports locations, so the page
 * matches the tab strip above it rather than an alphabetical accident.
 */
function groupByKind(
  statuses: readonly LibraryLocationStatus[],
  enabled: ReadonlySet<LibraryLocationId>
): LocationSettingGroup[] {
  const byKind = new Map<ResourceKind, LocationSetting[]>();
  for (const status of statuses) {
    const bucket = byKind.get(status.kind) ?? [];
    bucket.push({
      status,
      enabled: enabled.has(status.id),
      locked: LOCKED_LOCATIONS.has(status.id),
    });
    byKind.set(status.kind, bucket);
  }
  return [...byKind].map(([kind, locations]) => ({ kind, locations }));
}
