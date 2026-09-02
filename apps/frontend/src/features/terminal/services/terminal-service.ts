/**
 * Terminal HTTP: availability, the session list, and the open/rename/close
 * lifecycle.
 *
 * Raw `fetch`, not Eden Treaty: the module was written against the shared
 * contract before the hub routes existed, and `terminalFetch` replicates the
 * three behaviours `lib/api-client.ts`'s fetcher gives every Eden call —
 * negotiated problem-json errors, credentialed cookies, and a 401 sending the
 * tab back to the login flow — so this module fails the same way the rest of
 * the app does. Moving it onto `client.api.terminals` is a follow-up, not a
 * behaviour change.
 */

import { PROBLEM_JSON_ACCEPT } from '@mangostudio/shared/errors';
import type {
  TerminalAvailability,
  TerminalListResponse,
  TerminalOpenBody,
  TerminalRenameBody,
  TerminalSession,
  TerminalSessionResponse,
} from '@mangostudio/shared/terminal';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiBaseUrl } from '@/lib/api-base-url';
import { scheduleLoginRedirect } from '@/lib/auth-navigate';
import { ApiError } from '@/lib/utils';

export const terminalKeys = {
  all: ['terminals'] as const,
  availability: (environmentId: string) =>
    [...terminalKeys.all, 'availability', environmentId] as const,
  /** Prefix shared by every `chatId` scoping of one environment's sessions — the key an invalidation targets. */
  sessionsForEnvironment: (environmentId: string) =>
    [...terminalKeys.all, 'sessions', environmentId] as const,
  sessions: (environmentId: string, chatId?: string | null) =>
    [...terminalKeys.sessionsForEnvironment(environmentId), chatId ?? null] as const,
};

function terminalQueryString(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, value);
  }
  const serialized = query.toString();
  return serialized ? `?${serialized}` : '';
}

async function terminalFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('accept', PROBLEM_JSON_ACCEPT);
  if (init?.body !== undefined) headers.set('content-type', 'application/json');

  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });

  // Keyed on the status, never on the body — same rule as `api-client.ts`'s fetcher.
  if (response.status === 401) scheduleLoginRedirect();

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // Non-JSON error body: ApiError falls back to its neutral message.
    }
    throw new ApiError(body);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function terminalAvailabilityQueryOptions(environmentId: string) {
  return queryOptions({
    queryKey: terminalKeys.availability(environmentId),
    queryFn: () =>
      terminalFetch<TerminalAvailability>(
        `/api/terminals/availability${terminalQueryString({ environmentId })}`
      ),
  });
}

export function useTerminalAvailabilityQuery(environmentId: string, enabled = true) {
  return useQuery({ ...terminalAvailabilityQueryOptions(environmentId), enabled });
}

export function terminalSessionsQueryOptions(environmentId: string, chatId?: string | null) {
  return queryOptions({
    queryKey: terminalKeys.sessions(environmentId, chatId),
    queryFn: async () => {
      const response = await terminalFetch<TerminalListResponse>(
        `/api/terminals${terminalQueryString({ environmentId, chatId: chatId ?? undefined })}`
      );
      return response.sessions;
    },
  });
}

export function useTerminalSessionsQuery(
  environmentId: string,
  chatId: string | null | undefined,
  enabled = true
) {
  return useQuery({ ...terminalSessionsQueryOptions(environmentId, chatId), enabled });
}

/**
 * Every mutation below invalidates the whole terminal cache tree rather than
 * one scoped key. The rail panel (scoped to one chat) and the `/terminal`
 * page (scoped to one environment, every chat) read overlapping but
 * differently-keyed queries, and a session list is small enough that
 * refetching both is cheaper than teaching each mutation which of the two
 * callers is looking at it.
 */
function invalidateTerminals(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: terminalKeys.all });
}

export function useOpenTerminalMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: TerminalOpenBody): Promise<TerminalSession> => {
      const response = await terminalFetch<TerminalSessionResponse>('/api/terminals', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return response.session;
    },
    onSuccess: () => invalidateTerminals(queryClient),
  });
}

export function useRenameTerminalMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      body,
    }: {
      readonly id: string;
      readonly body: TerminalRenameBody;
    }): Promise<TerminalSession> => {
      const response = await terminalFetch<TerminalSessionResponse>(
        `/api/terminals/${encodeURIComponent(id)}`,
        { method: 'PATCH', body: JSON.stringify(body) }
      );
      return response.session;
    },
    onSuccess: () => invalidateTerminals(queryClient),
  });
}

export function useCloseTerminalMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string): Promise<void> =>
      terminalFetch<void>(`/api/terminals/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => invalidateTerminals(queryClient),
  });
}
