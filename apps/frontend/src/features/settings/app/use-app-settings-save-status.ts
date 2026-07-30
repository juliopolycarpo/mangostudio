import { useMutationState } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { appSettingsKeys } from './queries';

export type AppSettingsSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/** How long the acknowledgement lingers before the indicator goes quiet again. */
const SAVED_VISIBLE_MS = 2_000;

/**
 * Auto-save state for the app settings PUT, read from the mutation cache rather
 * than from a hook instance.
 *
 * The settings layout renders the indicator but does not own the write — every
 * section page runs its own `useGlobalSettings` — so the shared mutation key is
 * the only seam that sees all of them.
 */
export function useAppSettingsSaveStatus(): AppSettingsSaveStatus {
  const saves = useMutationState({
    filters: { mutationKey: appSettingsKeys.save() },
    select: (mutation) => ({
      status: mutation.state.status,
      submittedAt: mutation.state.submittedAt,
    }),
  });

  const latest = saves.at(-1);
  const status = latest?.status;
  // Keyed on the submission rather than on the status so two consecutive
  // successes restart the acknowledgement instead of sharing one window.
  const submittedAt = latest?.submittedAt;
  const [acknowledgedSubmission, setAcknowledgedSubmission] = useState<number>();

  useEffect(() => {
    if (status !== 'success' || submittedAt === undefined) return;

    setAcknowledgedSubmission(submittedAt);
    const timer = setTimeout(() => setAcknowledgedSubmission(undefined), SAVED_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [status, submittedAt]);

  if (status === 'pending') return 'saving';
  if (status === 'error') return 'error';
  return acknowledgedSubmission === undefined ? 'idle' : 'saved';
}
