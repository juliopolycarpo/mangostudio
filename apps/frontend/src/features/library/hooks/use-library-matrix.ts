/**
 * Everything the coverage matrix needs for one resource kind: the rows, the
 * columns, the filter state, and the row selection that feeds propagation.
 *
 * Selection is keyed by resource key and survives filtering, so narrowing to
 * "only divergent", ticking three rows, then widening the filter again does not
 * quietly drop the choices already made.
 */

import type {
  LibraryLocationStatus,
  LibraryResource,
  LibraryTargetDescriptor,
  LibraryTargetId,
  ResourceKind,
} from '@mangostudio/shared/library';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { rescanLibrary } from '../api';
import {
  DEFAULT_LIBRARY_FILTERS,
  filterResources,
  groupResourcesByLocation,
  hasActiveFilters,
  type LibraryFilters,
  type LocationGroup,
  sortResources,
} from '../format';
import {
  libraryKeys,
  libraryLocationsQueryOptions,
  libraryResourcesQueryOptions,
  libraryTargetsQueryOptions,
} from '../queries';

export interface LibraryMatrixState {
  readonly resources: readonly LibraryResource[];
  readonly visible: readonly LibraryResource[];
  readonly groups: readonly LocationGroup[];
  readonly targets: readonly LibraryTargetDescriptor[];
  readonly targetIds: readonly LibraryTargetId[];
  readonly locations: readonly LibraryLocationStatus[];
  readonly filters: LibraryFilters;
  readonly filtersActive: boolean;
  readonly setFilters: (update: Partial<LibraryFilters>) => void;
  readonly clearFilters: () => void;
  readonly selected: ReadonlySet<string>;
  readonly toggleSelected: (resourceKey: string) => void;
  readonly toggleAllVisible: () => void;
  readonly clearSelection: () => void;
  readonly isPending: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
  readonly rescan: () => void;
  readonly isRescanning: boolean;
}

export function useLibraryMatrix(kind: ResourceKind, environmentId?: string): LibraryMatrixState {
  const queryClient = useQueryClient();
  const [filters, setFiltersState] = useState<LibraryFilters>(DEFAULT_LIBRARY_FILTERS);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    setSelected(new Set());
    setFiltersState(DEFAULT_LIBRARY_FILTERS);
  }, [environmentId]);

  const [resourcesQuery, targetsQuery, locationsQuery] = useQueries({
    queries: [
      libraryResourcesQueryOptions(kind, environmentId),
      libraryTargetsQueryOptions(),
      libraryLocationsQueryOptions(environmentId),
    ],
  });

  const resources = useMemo(() => resourcesQuery.data ?? [], [resourcesQuery.data]);
  const targets = useMemo(() => targetsQuery.data ?? [], [targetsQuery.data]);
  const locations = useMemo(() => locationsQuery.data ?? [], [locationsQuery.data]);

  const visible = useMemo(
    () => sortResources(filterResources(resources, filters), filters.sort),
    [resources, filters]
  );
  const groups = useMemo(
    () =>
      filters.groupByLocation
        ? groupResourcesByLocation(visible)
        : [{ locationId: null, resources: visible }],
    [visible, filters.groupByLocation]
  );

  const rescan = useMutation({
    mutationFn: () => rescanLibrary(true, environmentId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: libraryKeys.all }),
  });

  const setFilters = useCallback((update: Partial<LibraryFilters>) => {
    setFiltersState((current) => ({ ...current, ...update }));
  }, []);

  const toggleSelected = useCallback((resourceKey: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(resourceKey)) next.add(resourceKey);
      return next;
    });
  }, []);

  const toggleAllVisible = useCallback(() => {
    setSelected((current) => {
      const visibleKeys = visible.map((resource) => resource.key);
      const allSelected = visibleKeys.every((key) => current.has(key));
      const next = new Set(current);
      for (const key of visibleKeys) {
        if (allSelected) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }, [visible]);

  const refetch = useCallback(() => {
    void resourcesQuery.refetch();
    void locationsQuery.refetch();
  }, [resourcesQuery, locationsQuery]);

  return {
    resources,
    visible,
    groups,
    targets,
    targetIds: useMemo(() => targets.map((target) => target.id), [targets]),
    locations,
    filters,
    filtersActive: hasActiveFilters(filters),
    setFilters,
    clearFilters: useCallback(() => setFiltersState(DEFAULT_LIBRARY_FILTERS), []),
    selected,
    toggleSelected,
    toggleAllVisible,
    clearSelection: useCallback(() => setSelected(new Set()), []),
    isPending: resourcesQuery.isPending || targetsQuery.isPending,
    error: resourcesQuery.error ?? targetsQuery.error,
    refetch,
    rescan: useCallback(() => rescan.mutate(), [rescan]),
    isRescanning: rescan.isPending,
  };
}
