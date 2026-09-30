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
 * Authentication failures are neither: they leave through the auth boundary
 * (a redirect to `/login`), never through a generic error panel.
 */

import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { EnsureQueryDataOptions, QueryClient, QueryKey } from '@tanstack/react-query';
import { type ChatWithContext, chatListQueryOptions } from '@/features/chat/queries';
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

/** What the layout loader learned from settling every shell responsibility. */
export interface ShellBootstrapOutcome {
  /** The chat list when it loaded; the loader seeds the first transcript from it. */
  readonly chats: readonly ChatWithContext[] | undefined;
  /** The first authentication failure among the responsibilities, if any. */
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
 * Settles every shell responsibility side by side.
 *
 * Never throws: a refused request is left failed in the query cache, where the
 * layout reads it, and an authentication failure is handed back for the caller
 * to redirect on.
 *
 * @example const { chats, authFailure } = await loadShellBootstrap(queryClient);
 */
export async function loadShellBootstrap(queryClient: QueryClient): Promise<ShellBootstrapOutcome> {
  const settled = await Promise.all([
    settleShellQuery(queryClient, chatListQueryOptions()),
    settleShellQuery(queryClient, catalogQueryOptions()),
    settleShellQuery(queryClient, agentSettingsListQueryOptions()),
  ]);
  const [chats] = settled;
  const authFailure = settled.find((result) => !result.ok && isAuthFailure(result.error));
  return {
    chats: chats.ok ? chats.data : undefined,
    authFailure: authFailure && !authFailure.ok ? authFailure.error : undefined,
  };
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
