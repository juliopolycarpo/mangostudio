/**
 * The remembered half of first-run setup.
 *
 * Progress lives in the person's app settings, so it follows their account
 * rather than the browser they happened to start in. Every write addresses only
 * `profileSettings.<profile>.onboarding`, which is what keeps a settings tab
 * open in another window from carrying a stale copy of it back.
 *
 * // Usage: const { state, update } = useOnboardingProgress();
 */

import {
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
  onboardingFor,
  onboardingPatch,
} from '@mangostudio/shared/app-settings';
import type { OnboardingState } from '@mangostudio/shared/onboarding';
import { DEFAULT_ONBOARDING_STATE } from '@mangostudio/shared/onboarding';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { updateAppSettings } from '@/features/settings/app/api';
import { markAppSettingsLocalWrite } from '@/features/settings/app/local-write-window';
import { appSettingsKeys, appSettingsQueryOptions } from '@/features/settings/app/queries';

export interface OnboardingProgress {
  readonly state: OnboardingState;
  /** True until the settings query has an answer; steps must not be judged before then. */
  readonly isLoading: boolean;
  readonly isSaving: boolean;
  readonly saveFailed: boolean;
  readonly update: (updater: (current: OnboardingState) => OnboardingState) => Promise<void>;
  /** Back to "never started", without touching anything else the person owns. */
  readonly reset: () => Promise<void>;
}

export function useOnboardingProgress(): OnboardingProgress {
  const queryClient = useQueryClient();
  const settings = useQuery(appSettingsQueryOptions());

  const save = useMutation({
    mutationFn: (next: OnboardingState | null) => updateAppSettings(onboardingPatch(next)),
    onSuccess: (saved) => {
      // The write window has to open here as well as at the click: the server
      // publishes its own `app` invalidation for this write, and without the
      // window that echo would refetch over the value it just confirmed.
      markAppSettingsLocalWrite();
      queryClient.setQueryData(appSettingsKeys.current(), normalizeAppSettings(saved));
    },
  });

  const { mutateAsync } = save;
  const update = useCallback(
    async (updater: (current: OnboardingState) => OnboardingState) => {
      // Read at call time rather than from the render that created this
      // callback, so a caller that awaits one write and then makes another
      // builds the second on what the first confirmed. Two writes started
      // *concurrently* are still last-one-wins: nothing is written to the cache
      // until the server answers, deliberately, because a record this one gates
      // navigation on must not be believed before it is stored. Callers that
      // can fire twice take `isSaving` and disable while one is open.
      const current = onboardingFor(
        normalizeAppSettings(
          queryClient.getQueryData(appSettingsKeys.current()) ?? DEFAULT_APP_SETTINGS
        )
      );
      markAppSettingsLocalWrite();
      await mutateAsync(updater(current));
    },
    [mutateAsync, queryClient]
  );

  const reset = useCallback(async () => {
    markAppSettingsLocalWrite();
    await mutateAsync(null);
  }, [mutateAsync]);

  return {
    state: settings.data ? onboardingFor(settings.data) : DEFAULT_ONBOARDING_STATE,
    isLoading: settings.isPending,
    isSaving: save.isPending,
    saveFailed: save.isError,
    update,
    reset,
  };
}
