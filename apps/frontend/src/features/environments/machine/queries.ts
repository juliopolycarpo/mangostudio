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
import { MACHINE_LOG_TAIL_DEFAULT } from '@mangostudio/shared/machine';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  changeMachineService,
  fetchMachineDoctor,
  fetchMachineLogs,
  fetchMachineStatus,
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
};

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
 * again after a bounded window either way.
 */
export function useMachineStatus(options: { readonly windowMs?: number } = {}) {
  const windowMs = options.windowMs ?? AFTER_ACTION_WINDOW_MS;
  const queryClient = useQueryClient();
  const [awaiting, setAwaiting] = useState<{ pid: number | null; since: number } | null>(null);

  const query = useQuery({
    ...machineStatusQueryOptions(),
    // Tighter than the shared interval only while an action is in flight.
    ...(awaiting ? { refetchInterval: AFTER_ACTION_POLL_MS } : {}),
  });

  const pid = query.data?.hub.pid ?? null;
  useEffect(() => {
    if (!awaiting) return;
    if (query.data !== undefined && pid !== awaiting.pid) setAwaiting(null);
  }, [awaiting, pid, query.data]);
  // Read inside the timeout below, which would otherwise close over the query
  // state as it was when the window opened.
  const freshness = useRef({ data: 0, error: 0 });
  freshness.current = { data: query.dataUpdatedAt, error: query.errorUpdatedAt };

  // A server that never comes back changes nothing the effect above watches,
  // so the window closes on a clock, not on data.
  useEffect(() => {
    if (!awaiting) return;
    const remaining = Math.max(0, windowMs - (Date.now() - awaiting.since));
    const timer = setTimeout(() => {
      setAwaiting(null);
      // Reaching here at all means no successor ever answered — the effect
      // above would have cleared `awaiting` if one had. What is left to ask is
      // whether the old process is still there: a failed refetch keeps the
      // last successful document in the cache, and that document would draw a
      // running hub with its service installed, which is exactly what an
      // uninstall just undid.
      //
      // The question is which of the two the *latest* fetch was, not whether
      // anything succeeded during the window. The mutation invalidates this
      // query the moment the action is accepted, and the server does not stand
      // down for another 50 ms, so a success from the old pid inside the window
      // is the normal case rather than a sign of life.
      //
      // A hub still answering on the same pid keeps its document; one that
      // answered once and then went away does not. The poll carries on either
      // way, so a server that comes back repopulates it.
      if (freshness.current.error >= freshness.current.data) {
        queryClient.removeQueries({ queryKey: machineKeys.status() });
      }
    }, remaining);
    return () => clearTimeout(timer);
  }, [awaiting, windowMs, queryClient]);

  const expectChange = useCallback(() => {
    setAwaiting({
      pid: queryClient.getQueryData<MachineStatus>(machineKeys.status())?.hub.pid ?? null,
      since: Date.now(),
    });
  }, [queryClient]);

  return { ...query, awaitingChange: awaiting !== null, expectChange };
}

export function useMachineDoctor(sections: readonly MachineDoctorSection[] = []) {
  return useQuery(machineDoctorQueryOptions(sections));
}

export function useMachineLogs(tail: number = MACHINE_LOG_TAIL_DEFAULT) {
  return useQuery(machineLogsQueryOptions(tail));
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
