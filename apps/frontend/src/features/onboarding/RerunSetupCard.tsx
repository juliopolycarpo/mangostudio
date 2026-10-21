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
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD } from '@/lib/icon-sizes';
import { useOnboardingProgress } from './use-onboarding-progress';

export function RerunSetupCard() {
  const { t } = useI18n();
  const s = t.onboarding.reenter;
  const navigate = useNavigate();
  const progress = useOnboardingProgress();

  return (
    <Card className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-fg">{s.title}</h3>
        <p className="text-sm text-fg-muted">{s.description}</p>
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
        <RotateCcw aria-hidden size={ICON_MD} />
        {s.action}
      </Button>
      {progress.saveFailed ? (
        <Callout tone="danger" data-testid="rerun-setup-failed">
          {t.onboarding.saveFailed}
        </Callout>
      ) : null}
    </Card>
  );
}
