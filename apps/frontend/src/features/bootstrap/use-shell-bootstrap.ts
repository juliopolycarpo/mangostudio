import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { chatListQueryOptions } from '@/features/chat/queries';
import { agentSettingsListQueryOptions } from '@/features/settings/agents/queries';
import { catalogQueryOptions } from '@/hooks/use-model-catalog';
import {
  isAuthFailure,
  isRateLimited,
  refetchShellResponsibility,
  SHELL_RESPONSIBILITIES,
  type ShellResponsibility,
} from './shell-bootstrap';

/** What the authenticated layout needs to know about its shell data. */
export interface ShellBootstrapState {
  /** Responsibilities that were refused and have never held data, in panel order. */
  readonly failed: readonly ShellResponsibility[];
  /**
   * The error the panel leads with: a rate limit when any failure is one (its
   * copy asks the person to wait, which matters whichever request hit it),
   * otherwise the first failure in panel order.
   */
  readonly error: unknown;
  /** True when a failure is an authentication failure, which the panel must not show. */
  readonly isAuthFailure: boolean;
  /** Fetches the failed responsibilities again, and nothing else. */
  readonly retry: () => Promise<void>;
}

/**
 * Reads whether any shell responsibility is failed, and retries only those.
 *
 * The readers are disabled observers: this hook reports cache state and never
 * starts a request of its own, so mounting it cannot become a retry. A failure
 * stays reported through its own retry — a refetch of a query with no data
 * resets its error — so the panel does not blink away and let pages mount
 * against data that is still missing. It clears the moment data arrives, from
 * this retry or from any other refetch (a reconnect, a realtime invalidation).
 *
 * @example
 * const bootstrap = useShellBootstrap();
 * if (bootstrap.failed.length > 0) return <BootstrapErrorPanel onRetry={bootstrap.retry} ... />;
 */
export function useShellBootstrap(): ShellBootstrapState {
  const queryClient = useQueryClient();
  const results = useQueries({
    queries: [
      { ...chatListQueryOptions(), enabled: false },
      { ...catalogQueryOptions(), enabled: false },
      { ...agentSettingsListQueryOptions(), enabled: false },
    ],
  });
  // The last error each responsibility reported. A retry clears the live one
  // while it runs, and the panel's headline (rate limited or not) should not
  // change under the person's cursor while they wait for it.
  const lastErrors = useRef(new Map<ShellResponsibility, unknown>());

  const failed = SHELL_RESPONSIBILITIES.filter((responsibility, index) => {
    const result = results[index];
    const hasFailed =
      result !== undefined && result.data === undefined && result.errorUpdateCount > 0;
    if (!hasFailed) {
      lastErrors.current.delete(responsibility);
      return false;
    }
    if (result.error) lastErrors.current.set(responsibility, result.error);
    return true;
  });
  const errors = failed.map((responsibility) => lastErrors.current.get(responsibility));

  return {
    failed,
    error: errors.find(isRateLimited) ?? errors[0],
    isAuthFailure: errors.some(isAuthFailure),
    retry: async () => {
      await Promise.allSettled(
        failed.map((responsibility) => refetchShellResponsibility(queryClient, responsibility))
      );
    },
  };
}
