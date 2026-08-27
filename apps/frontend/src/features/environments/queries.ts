/**
 * Environments query keys and options: runtimes, version managers, agent CLIs,
 * and the install recipe catalog.
 *
 * Probing is capped server-side at a few seconds, so every list keeps a short
 * `staleTime` and the route renders from cache while a re-probe runs.
 */

import type {
  AgentCliStatusList,
  ContainerDetection,
  CreateEnvironmentBody,
  Environment,
  InstallRecipePreview,
  RuntimeLifecycleStartResponse,
  RuntimeLifecycleView,
  RuntimePairedBootstrapBody,
  RuntimePairingIssue,
  RuntimePairingStatus,
  RuntimeSetupBody,
  RuntimeStatusList,
  UpdateEnvironmentBody,
  VersionManagerStatusList,
  WslDetection,
} from '@mangostudio/shared/environments';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
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

/**
 * Detection answers describe one machine, so every detection key carries the
 * environment it is about. A cache shared across machines would show WSL's
 * toolchains under Local's name for as long as the entry stayed fresh.
 */
export const environmentKeys = {
  all: ['environments'] as const,
  entities: () => [...environmentKeys.all, 'entities'] as const,
  runtimeLifecycle: (id: string) => [...environmentKeys.all, 'runtime-lifecycle', id] as const,
  runtimeSlotBytes: (id: string) => [...environmentKeys.all, 'runtime-slot-bytes', id] as const,
  runtimes: (environmentId: string = LOCAL_ENVIRONMENT_ID) =>
    [...environmentKeys.all, 'runtimes', environmentId] as const,
  versionManagers: (environmentId: string = LOCAL_ENVIRONMENT_ID) =>
    [...environmentKeys.all, 'version-managers', environmentId] as const,
  agents: (environmentId: string = LOCAL_ENVIRONMENT_ID) =>
    [...environmentKeys.all, 'agents', environmentId] as const,
  installRecipes: (environmentId: string = LOCAL_ENVIRONMENT_ID) =>
    [...environmentKeys.all, 'install-recipes', environmentId] as const,
  wsl: () => [...environmentKeys.all, 'wsl'] as const,
  containers: () => [...environmentKeys.all, 'containers'] as const,
  pairings: () => [...environmentKeys.all, 'pairing'] as const,
  pairing: (id: string) => [...environmentKeys.pairings(), id] as const,
};

/** `local` is the server default, so it never travels as a query parameter. */
function environmentQuery(environmentId: string): { environmentId?: string } {
  return environmentId === LOCAL_ENVIRONMENT_ID ? {} : { environmentId };
}

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
  useRealtimeInvalidation(ENVIRONMENTS_TOPIC, 'environment-entities', async () => {
    await queryClient.invalidateQueries({ queryKey: environmentKeys.entities() });
    // Pairing state moves on the same events: a runtime dialing in stamps its
    // credential as seen, and rotating or revoking one drops what it had
    // connected. Without this the panel keeps saying "never seen" about a
    // machine the card beside it already shows as connected.
    await queryClient.invalidateQueries({ queryKey: environmentKeys.pairings() });
  });
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
    // distribution an environment claims. Flipping allowInstalls also changes
    // which recipes the install catalog reports as runnable for that machine.
    onSuccess: async (environment) => {
      replaceEnvironment(queryClient, environment);
      await invalidateWslDetection(queryClient);
      await queryClient.invalidateQueries({
        queryKey: environmentKeys.installRecipes(environment.id),
      });
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
    mutationFn: async ({ id, removeRuntime = false }: { id: string; removeRuntime?: boolean }) => {
      const { data, error } = await client.api.environments({ id }).delete({
        query: removeRuntime ? { removeRuntime: true } : {},
      });
      if (error) throw new ApiError(error.value);
      return data;
    },
    onSuccess: (_, { id }) => {
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

export function useRuntimeLifecycleQuery(id: string, enabled = true) {
  return useQuery({
    queryKey: environmentKeys.runtimeLifecycle(id),
    enabled,
    staleTime: 5_000,
    refetchInterval: enabled ? 15_000 : false,
    queryFn: async () => {
      const { data, error } = await client.api.environments({ id }).runtime.get();
      if (error) throw new ApiError(error.value);
      return data as RuntimeLifecycleView;
    },
  });
}

/**
 * One-off byte count for the removal dialog. Unlike the polled lifecycle
 * query above, a WSL read here boots a stopped distribution, so it is only
 * fetched while the confirm dialog that needs it is open.
 */
export function useRuntimeSlotBytesQuery(id: string, enabled: boolean) {
  return useQuery({
    queryKey: environmentKeys.runtimeSlotBytes(id),
    enabled,
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await client.api
        .environments({ id })
        .runtime.get({ query: { slotBytes: true } });
      if (error) throw new ApiError(error.value);
      return (data as RuntimeLifecycleView).slotBytes;
    },
  });
}

export function useStartRuntimeInstallMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (action: 'install' | 'reinstall' | 'upgrade' | 'download') => {
      const { data, error } = await client.api
        .environments({ id })
        .runtime.install.post({ action });
      if (error) throw new ApiError(error.value);
      return data as RuntimeLifecycleStartResponse;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: environmentKeys.runtimeLifecycle(id) });
      await queryClient.invalidateQueries({ queryKey: environmentKeys.entities() });
    },
  });
}

export function useCancelRuntimeInstallMutation(id: string) {
  return useMutation({
    mutationFn: async (runId: string) => {
      const { data, error } = await client.api
        .environments({ id })
        .runtime.runs({ runId })
        .cancel.post();
      if (error) throw new ApiError(error.value);
      return data as { runId: string; cancellationRequested: boolean };
    },
  });
}

/**
 * Provisions an ssh-reachable machine so it dials the hub by itself.
 *
 * The ssh credentials travel in the body and are never stored: after this the
 * hub waits for that machine rather than reaching for it. The pairing token it
 * mints never comes back here either — it goes straight into the ssh channel,
 * so the browser holds no machine credential it has no use for.
 */
export function useStartPairedBootstrapMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: RuntimePairedBootstrapBody) => {
      const { data, error } = await client.api.environments({ id }).runtime.bootstrap.post(body);
      if (error) throw new ApiError(error.value);
      return data as RuntimeLifecycleStartResponse;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: environmentKeys.runtimeLifecycle(id) });
      await queryClient.invalidateQueries({ queryKey: environmentKeys.entities() });
    },
  });
}

export function useRuntimeSetupMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: RuntimeSetupBody) => {
      const { data, error } = await client.api.environments({ id }).runtime.setup.post(body);
      if (error) throw new ApiError(error.value);
      return data as RuntimeLifecycleView;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: environmentKeys.runtimeLifecycle(id) });
      await queryClient.invalidateQueries({ queryKey: environmentKeys.entities() });
    },
  });
}

export function runtimeStatusesQueryOptions(environmentId: string = LOCAL_ENVIRONMENT_ID) {
  return queryOptions({
    queryKey: environmentKeys.runtimes(environmentId),
    staleTime: STALE_TIME_MS,
    queryFn: async () => {
      const { data, error } = await client.api.environments.runtimes.get({
        query: environmentQuery(environmentId),
      });
      if (error) throw new ApiError(error.value);
      return data as RuntimeStatusList;
    },
  });
}

export function versionManagerStatusesQueryOptions(environmentId: string = LOCAL_ENVIRONMENT_ID) {
  return queryOptions({
    queryKey: environmentKeys.versionManagers(environmentId),
    staleTime: STALE_TIME_MS,
    queryFn: async () => {
      const { data, error } = await client.api.environments['version-managers'].get({
        query: environmentQuery(environmentId),
      });
      if (error) throw new ApiError(error.value);
      return data as VersionManagerStatusList;
    },
  });
}

export function agentCliStatusesQueryOptions(environmentId: string = LOCAL_ENVIRONMENT_ID) {
  return queryOptions({
    queryKey: environmentKeys.agents(environmentId),
    staleTime: STALE_TIME_MS,
    queryFn: async () => {
      const { data, error } = await client.api.environments.agents.get({
        query: environmentQuery(environmentId),
      });
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

/**
 * Which container engines this machine has. Asked only while the add dialog is
 * open: it spawns two CLIs, and the answer changes when someone installs or
 * starts an engine, not on a schedule.
 */
export function useContainerDetectionQuery(enabled: boolean) {
  return useQuery({
    queryKey: environmentKeys.containers(),
    enabled,
    staleTime: STALE_TIME_MS,
    queryFn: async () => {
      const { data, error } = await client.api.environments.containers.get();
      if (error) throw new ApiError(error.value);
      return data as ContainerDetection;
    },
  });
}

export function installRecipesQueryOptions(environmentId: string = LOCAL_ENVIRONMENT_ID) {
  return queryOptions({
    queryKey: environmentKeys.installRecipes(environmentId),
    staleTime: STALE_TIME_MS,
    queryFn: async () => {
      const { data, error } = await client.api.environments.install.recipes.get({
        query: environmentQuery(environmentId),
      });
      if (error) throw new ApiError(error.value);
      return data as InstallRecipePreview[];
    },
  });
}
