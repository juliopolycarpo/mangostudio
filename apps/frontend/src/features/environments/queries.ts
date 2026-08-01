/**
 * Environments query keys and options: runtimes, version managers, agent CLIs,
 * and the install recipe catalog.
 *
 * Probing is capped server-side at a few seconds, so every list keeps a short
 * `staleTime` and the route renders from cache while a re-probe runs.
 */

import type {
  AgentCliStatusList,
  CreateEnvironmentBody,
  Environment,
  InstallRecipePreview,
  RuntimePairingIssue,
  RuntimePairingStatus,
  RuntimeStatusList,
  UpdateEnvironmentBody,
  VersionManagerStatusList,
  WslDetection,
} from '@mangostudio/shared/environments';
import { ENVIRONMENTS_TOPIC } from '@mangostudio/shared/realtime';
import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { client } from '@/lib/api-client';
import { useRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import { ApiError } from '@/lib/utils';

const STALE_TIME_MS = 30_000;

export const environmentKeys = {
  all: ['environments'] as const,
  entities: () => [...environmentKeys.all, 'entities'] as const,
  runtimes: () => [...environmentKeys.all, 'runtimes'] as const,
  versionManagers: () => [...environmentKeys.all, 'version-managers'] as const,
  agents: () => [...environmentKeys.all, 'agents'] as const,
  installRecipes: () => [...environmentKeys.all, 'install-recipes'] as const,
  wsl: () => [...environmentKeys.all, 'wsl'] as const,
  pairing: (id: string) => [...environmentKeys.all, 'pairing', id] as const,
};

function environmentEntitiesQueryOptions() {
  return queryOptions({
    queryKey: environmentKeys.entities(),
    queryFn: async () => {
      const { data, error } = await client.api.environments.get();
      if (error) throw new ApiError(error.value);
      return data as Environment[];
    },
  });
}

export function useEnvironmentEntitiesQuery() {
  const queryClient = useQueryClient();
  useRealtimeInvalidation(ENVIRONMENTS_TOPIC, () =>
    queryClient.invalidateQueries({ queryKey: environmentKeys.entities() })
  );
  return useQuery(environmentEntitiesQueryOptions());
}

function replaceEnvironment(queryClient: QueryClient, environment: Environment): void {
  queryClient.setQueryData<Environment[]>(environmentKeys.entities(), (current) =>
    current?.map((item) => (item.id === environment.id ? environment : item))
  );
}

/**
 * The WSL listing marks which distributions an environment already claims, so
 * it is derived from the environments list and goes stale whenever that list
 * changes shape. Without this, adding one distribution and reopening the dialog
 * inside the `staleTime` window offers it again.
 */
function invalidateWslDetection(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: environmentKeys.wsl() });
}

export function useCreateEnvironmentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateEnvironmentBody) => {
      const { data, error } = await client.api.environments.post(body);
      if (error) throw new ApiError(error.value);
      return data as Environment;
    },
    // A new row changes the list's shape rather than one entry, and its status
    // starts moving the moment the server sees it, so refetch instead of
    // splicing a snapshot that is already stale.
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: environmentKeys.entities() });
      await invalidateWslDetection(queryClient);
    },
  });
}

export function useUpdateEnvironmentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: UpdateEnvironmentBody }) => {
      const { data, error } = await client.api.environments({ id }).put(updates);
      if (error) throw new ApiError(error.value);
      return data as Environment;
    },
    // An update can carry a new transport config, which is what decides the
    // distribution an environment claims.
    onSuccess: (environment) => {
      replaceEnvironment(queryClient, environment);
      return invalidateWslDetection(queryClient);
    },
  });
}

export function useConnectEnvironmentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await client.api.environments({ id }).connect.post();
      if (error) throw new ApiError(error.value);
      return data as Environment;
    },
    onSuccess: (environment) => replaceEnvironment(queryClient, environment),
  });
}

export function useDisconnectEnvironmentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await client.api.environments({ id }).disconnect.post();
      if (error) throw new ApiError(error.value);
      return data as Environment;
    },
    onSuccess: (environment) => replaceEnvironment(queryClient, environment),
  });
}

export function useRemoveEnvironmentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await client.api.environments({ id }).delete();
      if (error) throw new ApiError(error.value);
      return data;
    },
    onSuccess: (_, id) => {
      queryClient.setQueryData<Environment[]>(environmentKeys.entities(), (current) =>
        current?.filter((environment) => environment.id !== id)
      );
      // Removing an environment is what frees the distribution it claimed.
      return invalidateWslDetection(queryClient);
    },
  });
}

/**
 * Pairing state for one dial-in environment. The secret half of a token is
 * never in this payload — only whether one exists — so the response is safe to
 * cache like any other list entry.
 */
export function useRuntimePairingQuery(id: string, enabled: boolean) {
  return useQuery({
    queryKey: environmentKeys.pairing(id),
    enabled,
    queryFn: async () => {
      const { data, error } = await client.api.environments({ id }).pairing.get();
      if (error) throw new ApiError(error.value);
      return data as RuntimePairingStatus;
    },
  });
}

/**
 * Issues or rotates the credential. The response is the one and only time the
 * token is readable, so it is returned to the caller rather than written into
 * the cache the pairing query reads.
 */
export function useIssueRuntimePairingMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await client.api.environments({ id }).pairing.post();
      if (error) throw new ApiError(error.value);
      return data as RuntimePairingIssue;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: environmentKeys.pairing(id) }),
  });
}

export function useRevokeRuntimePairingMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await client.api.environments({ id }).pairing.delete();
      if (error) throw new ApiError(error.value);
      return data;
    },
    // Revoking drops whatever the credential had connected, so the card's own
    // status is stale too, not just the pairing panel's.
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: environmentKeys.pairing(id) });
      await queryClient.invalidateQueries({ queryKey: environmentKeys.entities() });
    },
  });
}

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

/**
 * Detection runs `wsl.exe`, which boots nothing but does talk to the Windows
 * host, so it is only fetched while the picker that needs it is open.
 */
export function useWslDetectionQuery(enabled: boolean) {
  return useQuery({
    queryKey: environmentKeys.wsl(),
    enabled,
    staleTime: STALE_TIME_MS,
    queryFn: async () => {
      const { data, error } = await client.api.environments.wsl.get();
      if (error) throw new ApiError(error.value);
      return data as WslDetection;
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
