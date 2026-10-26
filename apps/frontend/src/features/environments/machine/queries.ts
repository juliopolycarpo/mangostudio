/**
 * Query options and mutations for the machine page.
 *
 * Status is polled slowly all the time and quickly right after an action,
 * because the action's effect is a different process answering: the page
 * cannot be told, it can only look again.
 */

import type {
  MachineDoctorSection,
  MachineServiceAction,
  MachineStatus,
} from '@mangostudio/shared/machine';
import { MACHINE_LOG_TAIL_DEFAULT } from '@mangostudio/shared/machine/limits';
import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import {
  changeMachineService,
  fetchMachineDoctor,
  fetchMachineLogs,
  fetchMachineStatus,
  fetchMachineUpdate,
  restartMachine,
} from './api';

const STATUS_STALE_MS = 10_000;
const STATUS_POLL_MS = 15_000;
const AFTER_ACTION_POLL_MS = 2_000;
/** How long the fast poll runs before giving the server up as not coming back. */
const AFTER_ACTION_WINDOW_MS = 90_000;

const machineKeys = {
  all: ['machine'] as const,
  status: () => [...machineKeys.all, 'status'] as const,
  doctor: (sections: readonly MachineDoctorSection[]) =>
    [...machineKeys.all, 'doctor', [...sections].sort().join(',')] as const,
  logs: (tail: number) => [...machineKeys.all, 'logs', tail] as const,
  update: () => [...machineKeys.all, 'update'] as const,
};

const UPDATE_STALE_MS = 5 * 60_000;

export function machineStatusQueryOptions() {
  return queryOptions({
    queryKey: machineKeys.status(),
    queryFn: fetchMachineStatus,
    staleTime: STATUS_STALE_MS,
    refetchInterval: STATUS_POLL_MS,
    // Keep asking while the server is away; the error is the "reconnecting"
    // state, not a reason to stop.
    retry: false,
  });
}

/**
 * The self-update banner's whole input. Polled far more loosely than status:
 * a release check runs on the hub's own schedule, so refetching this on every
 * window focus is enough to catch it without a background poll.
 */
export function machineUpdateQueryOptions() {
  return queryOptions({
    queryKey: machineKeys.update(),
    queryFn: fetchMachineUpdate,
    staleTime: UPDATE_STALE_MS,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

/**
 * Invalidates the update query from outside a component that holds
 * `machineKeys` — `UpgradeDialog` calls this once an upgrade attempt ends, so
 * the banner and card read the hub's post-upgrade answer instead of the one
 * fetched before it ran.
 *
 * // Usage: invalidateMachineUpdate(queryClient)
 */
export function invalidateMachineUpdate(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: machineKeys.update() });
}

export function machineDoctorQueryOptions(sections: readonly MachineDoctorSection[] = []) {
  return queryOptions({
    queryKey: machineKeys.doctor(sections),
    queryFn: () => fetchMachineDoctor(sections),
    staleTime: STATUS_STALE_MS,
  });
}

export function machineLogsQueryOptions(tail: number = MACHINE_LOG_TAIL_DEFAULT) {
  return queryOptions({
    queryKey: machineKeys.logs(tail),
    queryFn: () => fetchMachineLogs(tail),
    staleTime: STATUS_STALE_MS,
  });
}

/**
 * The status query plus the "waiting for a different process" state. After an
 * accepted action the poll tightens until the pid changes — or the previous
 * process is simply gone, for an uninstall that stops the server — and relaxes
 * again after a bounded window either way. An in-flight request still owns its
 * eventual status verdict after that window closes.
 * @example
 * const machine = useMachineStatus();
 * machine.expectChange(); // An accepted restart or service action.
 */
export function useMachineStatus(options: { readonly windowMs?: number } = {}) {
  const windowMs = options.windowMs ?? AFTER_ACTION_WINDOW_MS;
  const queryClient = useQueryClient();
  const [awaiting, setAwaiting] = useState<{
    pid: number | null;
    since: number;
    expired: {
      dataUpdates: number;
      errorUpdates: number;
      fetching: boolean;
      failed: boolean;
    } | null;
  } | null>(null);
  const awaitingChange = awaiting !== null && awaiting.expired === null;

  const query = useQuery({
    ...machineStatusQueryOptions(),
    // Tighter than the shared interval only while an action is in flight.
    ...(awaitingChange ? { refetchInterval: AFTER_ACTION_POLL_MS } : {}),
  });

  // Read the cache itself: a request may settle before React receives its
  // observer notification, including on the same turn as the expiry timer.
  useEffect(() => {
    if (!awaiting) return;
    const latest = queryClient.getQueryState<MachineStatus>(machineKeys.status());
    if (latest?.data !== undefined && latest.data.hub.pid !== awaiting.pid) {
      setAwaiting(null);
      return;
    }
    const expiry = awaiting.expired;
    if (!expiry) return;
    // Completion counters retain a success even when another request fails
    // before React receives either observer notification. Timestamp ties do
    // not describe the latest outcome, and a newer fetch is not the old owner.
    const succeeded = latest !== undefined && latest.dataUpdateCount > expiry.dataUpdates;
    const failed = latest !== undefined && latest.errorUpdateCount > expiry.errorUpdates;
    if (expiry.fetching && !succeeded && !failed && latest?.fetchStatus === 'fetching') return;
    if (!succeeded && (expiry.fetching ? failed : expiry.failed)) {
      queryClient.removeQueries({ queryKey: machineKeys.status() });
    }
    setAwaiting(null);
  }, [awaiting, queryClient, query.dataUpdatedAt, query.errorUpdatedAt, query.fetchStatus]);

  useEffect(() => {
    if (!awaiting || awaiting.expired) return;
    const remaining = Math.max(0, windowMs - (Date.now() - awaiting.since));
    const timer = setTimeout(() => {
      const latest = queryClient.getQueryState<MachineStatus>(machineKeys.status());
      const expired = {
        dataUpdates: latest?.dataUpdateCount ?? 0,
        errorUpdates: latest?.errorUpdateCount ?? 0,
        fetching: latest?.fetchStatus === 'fetching',
        failed: latest?.status === 'error',
      };
      setAwaiting((current) => (current === awaiting ? { ...current, expired } : current));
    }, remaining);
    return () => clearTimeout(timer);
  }, [awaiting, windowMs, queryClient]);

  const expectChange = useCallback(() => {
    setAwaiting({
      pid: queryClient.getQueryData<MachineStatus>(machineKeys.status())?.hub.pid ?? null,
      since: Date.now(),
      expired: null,
    });
  }, [queryClient]);

  return { ...query, awaitingChange, expectChange };
}

export function useMachineDoctor(sections: readonly MachineDoctorSection[] = []) {
  return useQuery(machineDoctorQueryOptions(sections));
}

export function useMachineLogs(tail: number = MACHINE_LOG_TAIL_DEFAULT) {
  return useQuery(machineLogsQueryOptions(tail));
}

export function useMachineUpdate() {
  return useQuery(machineUpdateQueryOptions());
}

export function useRestartMachineMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: restartMachine,
    onSettled: () => queryClient.invalidateQueries({ queryKey: machineKeys.all }),
  });
}

export function useChangeMachineServiceMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: MachineServiceAction) => changeMachineService(action),
    onSettled: () => queryClient.invalidateQueries({ queryKey: machineKeys.all }),
  });
}
