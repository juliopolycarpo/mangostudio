/**
 * The way back into first-run setup, from the settings page.
 *
 * Setup must never be the only way to do the things it does, and it must never
 * be a one-way door either. Clearing progress writes only the onboarding
 * record: chats, vendor sign-ins and machine settings are untouched, which is
 * exactly what the copy promises.
 */

import { useNavigate } from '@tanstack/react-router';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useI18n } from '@/hooks/use-i18n';
import { useOnboardingProgress } from './use-onboarding-progress';

export function RerunSetupCard() {
  const { t } = useI18n();
  const s = t.onboarding.reenter;
  const navigate = useNavigate();
  const progress = useOnboardingProgress();

  return (
    <Card variant="solid" className="space-y-4 p-4 sm:p-6">
      <div className="space-y-1">
        <h3 className="font-label font-bold text-on-surface-variant/80 text-xs uppercase tracking-widest">
          {s.title}
        </h3>
        <p className="text-on-surface-variant/60 text-sm">{s.description}</p>
      </div>
      <Button
        variant="secondary"
        data-testid="rerun-setup"
        loading={progress.isSaving}
        onClick={() => {
          // The navigation is inside the success branch, and the rejection is
          // caught rather than left to float: opening the wizard on progress
          // the server still holds would show a finished run and say nothing
          // about the write that failed.
          void progress
            .reset()
            .then(() => navigate({ to: '/welcome' }))
            .catch(() => undefined);
        }}
      >
        <RotateCcw aria-hidden size={15} />
        {s.action}
      </Button>
      {progress.saveFailed ? (
        <p className="text-error text-sm" data-testid="rerun-setup-failed">
          {t.onboarding.saveFailed}
        </p>
      ) : null}
    </Card>
  );
}
