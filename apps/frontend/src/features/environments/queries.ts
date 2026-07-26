/**
 * Environments query keys and options: runtimes, version managers, agent CLIs,
 * and the install recipe catalog.
 *
 * Probing is capped server-side at a few seconds, so every list keeps a short
 * `staleTime` and the route renders from cache while a re-probe runs.
 */

import type {
  AgentCliStatusList,
  InstallRecipePreview,
  RuntimeStatusList,
  VersionManagerStatusList,
} from '@mangostudio/shared/environments';
import { queryOptions } from '@tanstack/react-query';
import { client } from '@/lib/api-client';
import { ApiError } from '@/lib/utils';

const STALE_TIME_MS = 30_000;

export const environmentKeys = {
  all: ['environments'] as const,
  runtimes: () => [...environmentKeys.all, 'runtimes'] as const,
  versionManagers: () => [...environmentKeys.all, 'version-managers'] as const,
  agents: () => [...environmentKeys.all, 'agents'] as const,
  installRecipes: () => [...environmentKeys.all, 'install-recipes'] as const,
};

export function runtimeStatusesQueryOptions() {
  return queryOptions({
    queryKey: environmentKeys.runtimes(),
    staleTime: STALE_TIME_MS,
    queryFn: async () => {
      const { data, error } = await client.api.environments.runtimes.get();
      if (error) throw new ApiError(error.value);
      return data as RuntimeStatusList;
    },
  });
}

export function versionManagerStatusesQueryOptions() {
  return queryOptions({
    queryKey: environmentKeys.versionManagers(),
    staleTime: STALE_TIME_MS,
    queryFn: async () => {
      const { data, error } = await client.api.environments['version-managers'].get();
      if (error) throw new ApiError(error.value);
      return data as VersionManagerStatusList;
    },
  });
}

export function agentCliStatusesQueryOptions() {
  return queryOptions({
    queryKey: environmentKeys.agents(),
    staleTime: STALE_TIME_MS,
    queryFn: async () => {
      const { data, error } = await client.api.environments.agents.get();
      if (error) throw new ApiError(error.value);
      return data as AgentCliStatusList;
    },
  });
}

export function installRecipesQueryOptions() {
  return queryOptions({
    queryKey: environmentKeys.installRecipes(),
    staleTime: STALE_TIME_MS,
    queryFn: async () => {
      const { data, error } = await client.api.environments.install.recipes.get();
      if (error) throw new ApiError(error.value);
      return data as InstallRecipePreview[];
    },
  });
}
