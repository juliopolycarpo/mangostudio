/**
 * The word beside a step in the flow's list: done, skipped, still to do.
 *
 * A separate component because "checking" and "not available here" are states
 * the flow must be able to say out loud — a spinner or a blank would both read
 * as "not done yet", and neither is true. Only "done" carries a colour; every
 * other state is the neutral badge, so the list never has a row that sometimes
 * has a status and sometimes none.
 */

import type { OnboardingStepStatus } from '@mangostudio/shared/onboarding';
import type { ComponentProps } from 'react';
import { Badge } from '@/components/ui/Badge';
import { useI18n } from '@/hooks/use-i18n';

const VARIANT: Record<
  OnboardingStepStatus,
  NonNullable<ComponentProps<typeof Badge>['variant']>
> = {
  satisfied: 'success',
  skipped: 'neutral',
  pending: 'neutral',
  unknown: 'neutral',
  unavailable: 'neutral',
};

export function StepStatusChip({ status }: { readonly status: OnboardingStepStatus }) {
  const { t } = useI18n();

  return (
    <Badge data-status={status} variant={VARIANT[status]}>
      {t.onboarding.status[status]}
    </Badge>
  );
}
