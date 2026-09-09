/**
 * The word beside a step in the flow's list: done, skipped, still to do.
 *
 * A separate component because "checking" and "not available here" are states
 * the flow must be able to say out loud — a spinner or a blank would both read
 * as "not done yet", and neither is true.
 */

import type { OnboardingStepStatus } from '@mangostudio/shared/onboarding';
import { useI18n } from '@/hooks/use-i18n';

const TONE: Record<OnboardingStepStatus, string> = {
  satisfied: 'bg-primary/15 text-primary',
  skipped: 'bg-surface-container-highest text-on-surface-variant/70',
  pending: 'bg-surface-container-highest text-on-surface-variant',
  unknown: 'bg-surface-container-highest text-on-surface-variant/50',
  unavailable: 'bg-surface-container-highest text-on-surface-variant/50',
};

export function StepStatusChip({ status }: { readonly status: OnboardingStepStatus }) {
  const { t } = useI18n();

  return (
    <span
      data-status={status}
      className={`shrink-0 whitespace-nowrap rounded-md px-1.5 py-0.5 font-label font-semibold text-[10px] uppercase tracking-wider ${TONE[status]}`}
    >
      {t.onboarding.status[status]}
    </span>
  );
}
