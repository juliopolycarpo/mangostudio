/**
 * Library query keys and options: the resource matrix, the locations behind its
 * columns, the target registry that defines them, and the read-only settings
 * comparison.
 *
 * Discovery is cached server-side, so a short `staleTime` keeps navigation
 * between the kind tabs instant while a rescan stays an explicit action.
 */

import type {
  ConceptComparison,
  LibraryLocationId,
  LibraryLocationStatus,
  LibraryResource,
  LibraryResourceContent,
  LibraryTargetDescriptor,
  PropagationBackupUsage,
  ResourceKind,
} from '@mangostudio/shared/library';
import { queryOptions } from '@tanstack/react-query';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

const STALE_TIME_MS = 30_000;

export const libraryKeys = {
  all: ['library'] as const,
  resources: (kind?: ResourceKind) => [...libraryKeys.all, 'resources', kind ?? 'all'] as const,
  resource: (key: string) => [...libraryKeys.all, 'resource', key] as const,
  content: (key: string, locationId: LibraryLocationId) =>
    [...libraryKeys.all, 'content', key, locationId] as const,
  locations: () => [...libraryKeys.all, 'locations'] as const,
  targets: () => [...libraryKeys.all, 'targets'] as const,
  settingsComparison: () => [...libraryKeys.all, 'settings', 'compare'] as const,
  backups: () => [...libraryKeys.all, 'backups'] as const,
};

export function libraryResourcesQueryOptions(kind?: ResourceKind) {
  return queryOptions({
    queryKey: libraryKeys.resources(kind),
    staleTime: STALE_TIME_MS,
    queryFn: async () => {
      const { data, error } = await client.api.library.resources.get({
        query: kind ? { kind } : {},
      });
      if (error) throw new ApiError(error.value);
      return data as LibraryResource[];
    },
  });
}

export function libraryResourceQueryOptions(key: string) {
  return queryOptions({
    queryKey: libraryKeys.resource(key),
    staleTime: STALE_TIME_MS,
    queryFn: async () => {
      const { data, error } = await client.api.library.resources({ key }).get();
      if (error) throw new ApiError(error.value);
      return data as LibraryResource;
    },
  });
}

/**
 * One copy's text, for the diff viewer. A skill is a directory and the route
 * serves its `SKILL.md`, so a comparison of two skill versions is a comparison
 * of their entrypoints — the detail view says so rather than implying the whole
 * tree was compared.
 */
export function libraryContentQueryOptions(key: string, locationId: LibraryLocationId) {
  return queryOptions({
    queryKey: libraryKeys.content(key, locationId),
    staleTime: STALE_TIME_MS,
    queryFn: async () => {
      const { data, error } = await client.api.library
        .resources({ key })
        .content.get({ query: { location: locationId } });
      if (error) throw new ApiError(error.value);
      return data as LibraryResourceContent;
    },
  });
}

export function libraryLocationsQueryOptions() {
  return queryOptions({
    queryKey: libraryKeys.locations(),
    staleTime: STALE_TIME_MS,
    queryFn: async () => {
      const { data, error } = await client.api.library.locations.get();
      if (error) throw new ApiError(error.value);
      return data as LibraryLocationStatus[];
    },
  });
}

/**
 * The matrix has one column per target, and the column set must not depend on
 * which rows happen to survive a filter — an empty result still owes the user
 * the full header.
 */
export function libraryTargetsQueryOptions() {
  return queryOptions({
    queryKey: libraryKeys.targets(),
    // The registry is code-defined and cannot change without a deploy.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const { data, error } = await client.api.library.targets.get();
      if (error) throw new ApiError(error.value);
      return data as LibraryTargetDescriptor[];
    },
  });
}

export function settingsComparisonQueryOptions() {
  return queryOptions({
    queryKey: libraryKeys.settingsComparison(),
    staleTime: STALE_TIME_MS,
    queryFn: async () => {
      const { data, error } = await client.api.library.settings.compare.get();
      if (error) throw new ApiError(error.value);
      return data as ConceptComparison[];
    },
  });
}

export function backupUsageQueryOptions() {
  return queryOptions({
    queryKey: libraryKeys.backups(),
    staleTime: STALE_TIME_MS,
    queryFn: async () => {
      const { data, error } = await client.api.library.propagate.backups.get();
      if (error) throw new ApiError(error.value);
      return data as PropagationBackupUsage;
    },
  });
}
