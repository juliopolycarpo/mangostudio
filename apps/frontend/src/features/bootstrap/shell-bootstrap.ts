/**
 * The data the authenticated shell loads for every page once the gates in
 * front of it have passed.
 *
 * Two classes of bootstrap data, deliberately kept apart:
 *
 * - The gate's data (app settings) decides whether this person may see the
 *   application at all — setup finished or not. A failure there has nothing
 *   safe to show, so it stays a full-surface failure in `beforeLoad`.
 * - The shell's data (chats, the model catalog, agent settings) is what the
 *   pages read. Each is settled on its own, so one refused request no longer
 *   takes navigation down with it; the layout swaps its content region for the
 *   bootstrap panel instead and retries only what failed.
 *
 * Only the chat list is waited for before the first screen, because it names
 * the chat that screen opens — and its first transcript page is asked for the
 * moment it does. The catalog and agent settings are started alongside it but
 * not awaited: the catalog waits on provider discovery after a hub restart,
 * and nothing about the shell or the transcript depends on it. Their readers
 * show their own loading states, and the composer does not send until the
 * catalog has answered.
 *
 * Authentication failures are neither: they leave through the auth boundary
 * (a redirect to `/login`), never through a generic error panel.
 */

import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { EnsureQueryDataOptions, QueryClient, QueryKey } from '@tanstack/react-query';
import {
  type ChatWithContext,
  chatListQueryOptions,
  messagesQueryOptions,
} from '@/features/chat/queries';
import { agentSettingsListQueryOptions } from '@/features/settings/agents/queries';
import { catalogQueryOptions } from '@/hooks/use-model-catalog';
import { ApiError } from '@/lib/utils';

/** One independently loaded, independently retried piece of shell data. */
export type ShellResponsibility = 'chats' | 'catalog' | 'agents';

/** Every shell responsibility, in the order the panel names them. */
export const SHELL_RESPONSIBILITIES: readonly ShellResponsibility[] = [
  'chats',
  'catalog',
  'agents',
];

/** How one responsibility settled: its data, or the error that refused it. */
export type ShellSettlement<TData> =
  | { readonly ok: true; readonly data: TData }
  | { readonly ok: false; readonly error: unknown };

/** What the layout loader learned from the data the first screen waits for. */
export interface ShellBootstrapOutcome {
  /** The chat list when it loaded; its first chat's transcript is already requested. */
  readonly chats: readonly ChatWithContext[] | undefined;
  /**
   * The chat list's authentication failure, if it had one.
   *
   * Only the awaited responsibility can report one here. A catalog or agent
   * settings request refused for the session settles after the loader has
   * returned; it leaves through the API client's login redirect instead, and
   * the layout renders nothing protected while that runs.
   */
  readonly authFailure: unknown;
}

/**
 * Whether an error means the session is gone rather than that a request broke.
 *
 * Such a failure belongs to the auth boundary: rendering a retry panel over
 * the shell would keep protected data on screen for a session the server has
 * already rejected.
 *
 * @example isAuthFailure(new ApiError({ error: 'Unauthorized', code: 'UNAUTHORIZED' })) // true
 */
export function isAuthFailure(error: unknown): boolean {
  return error instanceof ApiError && error.code === ERROR_CODES.UNAUTHORIZED;
}

/**
 * Whether an error is the hub's rate limit.
 *
 * The bootstrap panel leads with "wait before retrying" for it, because an
 * immediate retry would only be refused again.
 *
 * @example isRateLimited(new ApiError({ error: 'Too many requests', code: 'RATE_LIMITED' })) // true
 */
export function isRateLimited(error: unknown): boolean {
  return error instanceof ApiError && error.code === ERROR_CODES.RATE_LIMITED;
}

/**
 * Whether a cached query has failed without ever holding data.
 *
 * Read from `errorUpdateCount` rather than `status`: a refetch of a query with
 * no data resets its status to `pending` and clears its error, so a status
 * check would report "not failed" for the length of every retry and let the
 * pages mount against data that is still missing.
 *
 * @example hasFailedWithoutData(queryClient, chatKeys.lists()) // true after a refused first load
 */
function hasFailedWithoutData(queryClient: QueryClient, queryKey: QueryKey): boolean {
  const state = queryClient.getQueryState(queryKey);
  return state !== undefined && state.data === undefined && state.errorUpdateCount > 0;
}

/**
 * Loads one shell query without throwing, and without re-asking for one that
 * already failed.
 *
 * The router re-runs a stale loader on every navigation and intent preload, so
 * a loader that refetched a refused request would retry it once per hover.
 * A failure is retried by the bootstrap panel's action instead. Authentication
 * failures are exempt: a later session (after signing in again) must not
 * inherit the one that expired.
 *
 * @example const settled = await settleShellQuery(queryClient, chatListQueryOptions());
 */
export async function settleShellQuery<TData, TKey extends QueryKey>(
  queryClient: QueryClient,
  options: EnsureQueryDataOptions<TData, Error, TData, TKey>
): Promise<ShellSettlement<TData>> {
  const state = queryClient.getQueryState(options.queryKey);
  if (hasFailedWithoutData(queryClient, options.queryKey) && !isAuthFailure(state?.error)) {
    return { ok: false, error: state?.error };
  }
  try {
    return { ok: true, data: await queryClient.ensureQueryData(options) };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Starts the shell responsibilities the first screen does not wait for.
 *
 * Deliberately not awaited: each settles into the query cache on its own,
 * where its readers show a loading state until it lands and the bootstrap
 * panel takes over if it is refused. `settleShellQuery` never rejects, so
 * nothing here can surface as an unhandled rejection.
 *
 * @example startDeferredShellQueries(queryClient); // returns immediately
 */
function startDeferredShellQueries(queryClient: QueryClient): void {
  void settleShellQuery(queryClient, catalogQueryOptions());
  void settleShellQuery(queryClient, agentSettingsListQueryOptions());
}

/**
 * Loads what the first screen needs, and starts the rest without waiting.
 *
 * Waits for the chat list alone, then for the first chat's transcript page,
 * which is chained from it so it is in flight while the catalog may still be
 * waiting on provider discovery. A refused transcript is left to the chat
 * page, which asks again when it mounts.
 *
 * Never throws: a refused request is left failed in the query cache, where the
 * layout reads it, and the chat list's authentication failure is handed back
 * for the caller to redirect on.
 *
 * @example const { chats, authFailure } = await loadShellBootstrap(queryClient);
 */
export async function loadShellBootstrap(queryClient: QueryClient): Promise<ShellBootstrapOutcome> {
  startDeferredShellQueries(queryClient);
  const chats = await settleShellQuery(queryClient, chatListQueryOptions());
  if (!chats.ok) {
    return { chats: undefined, authFailure: isAuthFailure(chats.error) ? chats.error : undefined };
  }
  const firstChatId = chats.data[0]?.id;
  if (firstChatId) await queryClient.prefetchInfiniteQuery(messagesQueryOptions(firstChatId));
  return { chats: chats.data, authFailure: undefined };
}

/**
 * Fetches one responsibility again, whatever its cache state.
 *
 * `fetchQuery` rather than `refetchQueries`: the latter skips a query whose
 * observers are all disabled, and the panel's own readers are disabled.
 *
 * @example await refetchShellResponsibility(queryClient, 'catalog');
 */
export function refetchShellResponsibility(
  queryClient: QueryClient,
  responsibility: ShellResponsibility
): Promise<unknown> {
  if (responsibility === 'chats') return queryClient.fetchQuery(chatListQueryOptions());
  if (responsibility === 'catalog') return queryClient.fetchQuery(catalogQueryOptions());
  return queryClient.fetchQuery(agentSettingsListQueryOptions());
}
