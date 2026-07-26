/**
 * Environment status hooks: the three detection lists, a forced re-probe per
 * entity, and the flat finding list the health page renders.
 */

import type {
  AgentCliStatus,
  RuntimeFinding,
  RuntimeId,
  RuntimeStatus,
  VersionManagerId,
  VersionManagerStatus,
} from '@mangostudio/shared/environments';
import type { LibraryTargetId } from '@mangostudio/shared/library';
import {
  type QueryClient,
  type QueryKey,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useMemo } from 'react';
import { probeAgentCli, probeRuntime, probeVersionManager } from '../api';
import { findingSeverity } from '../format';
import {
  agentCliStatusesQueryOptions,
  environmentKeys,
  installRecipesQueryOptions,
  runtimeStatusesQueryOptions,
  versionManagerStatusesQueryOptions,
} from '../queries';

function useRuntimeStatuses() {
  return useQuery(runtimeStatusesQueryOptions());
}

function useVersionManagerStatuses() {
  return useQuery(versionManagerStatusesQueryOptions());
}

export function useAgentCliStatuses() {
  return useQuery(agentCliStatusesQueryOptions());
}

export function useInstallRecipes() {
  return useQuery(installRecipesQueryOptions());
}

/**
 * The runtimes screen needs both lists at once, and neither should block the
 * other: nvm being slow to enumerate must not delay "which node runs".
 */
export function useRuntimesScreenData() {
  const results = useQueries({
    queries: [
      runtimeStatusesQueryOptions(),
      versionManagerStatusesQueryOptions(),
      installRecipesQueryOptions(),
    ],
  });
  const [runtimes, versionManagers, recipes] = results;

  return {
    runtimes: runtimes?.data ?? [],
    versionManagers: versionManagers?.data ?? [],
    recipes: recipes?.data ?? [],
    isPending: results.some((result) => result.isPending),
    error: results.find((result) => result.error)?.error ?? null,
    refetch: () => {
      for (const result of results) void result.refetch();
    },
  };
}

/**
 * Replaces one entry of a cached status list with a freshly probed one.
 *
 * `setQueryData` treats an updater that returns undefined as a no-op, so a list
 * that is not cached yet would silently swallow the probe result. Invalidate in
 * that case: the next read refetches rather than showing stale data.
 */
function writeProbedStatus<T>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  status: T,
  isSameEntity: (entry: T) => boolean
) {
  const written = queryClient.setQueryData(queryKey, (current: T[] | undefined) =>
    current?.map((entry) => (isSameEntity(entry) ? status : entry))
  );
  if (!written) void queryClient.invalidateQueries({ queryKey });
}

/** Forces a fresh probe and writes the result straight into the list cache. */
export function useProbeRuntime() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: RuntimeId) => probeRuntime(id),
    onSuccess: (status) => {
      writeProbedStatus(
        queryClient,
        environmentKeys.runtimes(),
        status,
        (entry: RuntimeStatus) => entry.id === status.id
      );
    },
  });
}

export function useProbeVersionManager() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: VersionManagerId) => probeVersionManager(id),
    onSuccess: (status) => {
      writeProbedStatus(
        queryClient,
        environmentKeys.versionManagers(),
        status,
        (entry: VersionManagerStatus) => entry.id === status.id
      );
    },
  });
}

export function useProbeAgentCli() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (targetId: LibraryTargetId) => probeAgentCli(targetId),
    onSuccess: (status) => {
      writeProbedStatus(
        queryClient,
        environmentKeys.agents(),
        status,
        (entry: AgentCliStatus) => entry.targetId === status.targetId
      );
    },
  });
}

export type HealthScope = 'runtime' | 'version-manager' | 'agent';

interface HealthEntry {
  readonly key: string;
  readonly scope: HealthScope;
  /** Runtime id, version manager id, or agent target id. */
  readonly subjectId: string;
  readonly finding: RuntimeFinding;
  readonly severity: ReturnType<typeof findingSeverity>;
}

const SEVERITY_RANK: Record<HealthEntry['severity'], number> = { fail: 0, warn: 1 };

/**
 * Every finding across runtimes, version managers, and agent CLIs as one flat
 * list sorted worst-first — the browser equivalent of `mango doctor`.
 */
export function useEnvironmentHealth() {
  const runtimes = useRuntimeStatuses();
  const versionManagers = useVersionManagerStatuses();
  const agents = useAgentCliStatuses();

  const entries = useMemo(() => {
    const collected: HealthEntry[] = [];
    const collect = (
      scope: HealthScope,
      subjectId: string,
      findings: readonly RuntimeFinding[]
    ) => {
      findings.forEach((finding, index) => {
        collected.push({
          key: `${scope}:${subjectId}:${finding.code}:${index}`,
          scope,
          subjectId,
          finding,
          severity: findingSeverity(finding),
        });
      });
    };

    for (const runtime of runtimes.data ?? []) collect('runtime', runtime.id, runtime.findings);
    for (const manager of versionManagers.data ?? []) {
      collect('version-manager', manager.id, manager.findings);
    }
    for (const agent of agents.data ?? []) collect('agent', agent.targetId, agent.findings);

    return collected.sort(
      (left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
    );
  }, [runtimes.data, versionManagers.data, agents.data]);

  return {
    entries,
    isPending: runtimes.isPending || versionManagers.isPending || agents.isPending,
    error: runtimes.error ?? versionManagers.error ?? agents.error ?? null,
    refetch: () => {
      void runtimes.refetch();
      void versionManagers.refetch();
      void agents.refetch();
    },
  };
}
