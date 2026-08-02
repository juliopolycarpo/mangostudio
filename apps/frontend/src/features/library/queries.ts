/**
 * Library query keys and options: the resource matrix, the locations behind its
 * columns, the target registry that defines them, and the read-only settings
 * comparison.
 *
 * Discovery is cached server-side, so a short `staleTime` keeps navigation
 * between the kind tabs instant while a rescan stays an explicit action.
 * Query keys include the environment so switching machines cannot reuse the
 * previous matrix as if it described the new one.
 */

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
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

function environmentQuery(environmentId?: string): { environmentId?: string } {
  return environmentId && environmentId !== LOCAL_ENVIRONMENT_ID ? { environmentId } : {};
}

export const libraryKeys = {
  all: ['library'] as const,
  resources: (kind?: ResourceKind, environmentId: string = LOCAL_ENVIRONMENT_ID) =>
    [...libraryKeys.all, 'resources', environmentId, kind ?? 'all'] as const,
  resource: (key: string, environmentId: string = LOCAL_ENVIRONMENT_ID) =>
    [...libraryKeys.all, 'resource', environmentId, key] as const,
  content: (
    key: string,
    locationId: LibraryLocationId,
    environmentId: string = LOCAL_ENVIRONMENT_ID
  ) => [...libraryKeys.all, 'content', environmentId, key, locationId] as const,
  locations: (environmentId: string = LOCAL_ENVIRONMENT_ID) =>
    [...libraryKeys.all, 'locations', environmentId] as const,
  targets: () => [...libraryKeys.all, 'targets'] as const,
  settingsComparison: () => [...libraryKeys.all, 'settings', 'compare'] as const,
  backups: () => [...libraryKeys.all, 'backups'] as const,
};

export function libraryResourcesQueryOptions(kind?: ResourceKind, environmentId?: string) {
  const envId = environmentId ?? LOCAL_ENVIRONMENT_ID;
  return queryOptions({
    queryKey: libraryKeys.resources(kind, envId),
    staleTime: STALE_TIME_MS,
    queryFn: async () => {
      const { data, error } = await client.api.library.resources.get({
        query: {
          ...(kind ? { kind } : {}),
          ...environmentQuery(envId),
        },
      });
      if (error) throw new ApiError(error.value);
      return data as LibraryResource[];
    },
  });
}

export function libraryResourceQueryOptions(key: string, environmentId?: string) {
  const envId = environmentId ?? LOCAL_ENVIRONMENT_ID;
  return queryOptions({
    queryKey: libraryKeys.resource(key, envId),
    staleTime: STALE_TIME_MS,
    queryFn: async () => {
      const { data, error } = await client.api.library.resources({ key }).get({
        query: environmentQuery(envId),
      });
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
export function libraryContentQueryOptions(
  key: string,
  locationId: LibraryLocationId,
  environmentId?: string
) {
  const envId = environmentId ?? LOCAL_ENVIRONMENT_ID;
  return queryOptions({
    queryKey: libraryKeys.content(key, locationId, envId),
    staleTime: STALE_TIME_MS,
    queryFn: async () => {
      const { data, error } = await client.api.library.resources({ key }).content.get({
        query: { location: locationId, ...environmentQuery(envId) },
      });
      if (error) throw new ApiError(error.value);
      return data as LibraryResourceContent;
    },
  });
}

export function libraryLocationsQueryOptions(environmentId?: string) {
  const envId = environmentId ?? LOCAL_ENVIRONMENT_ID;
  return queryOptions({
    queryKey: libraryKeys.locations(envId),
    staleTime: STALE_TIME_MS,
    queryFn: async () => {
      const { data, error } = await client.api.library.locations.get({
        query: environmentQuery(envId),
      });
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
