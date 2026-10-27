/**
 * Step — what MangoStudio may do on that machine.
 *
 * For many people this is their first contact with runtime consent, which is
 * why the choice is made in {@link RuntimeConsentDialog} rather than in copy
 * written for the wizard: one profile picker, one `allow.shell` honesty string,
 * one confirm. A second set of words here would be a fork of the surface that
 * carries the honesty burden.
 *
 * When the answer takes effect differs by end state, and only because of what
 * exists at this point in each flow. An ssh environment already has the binary
 * on the machine and a stored config to reach it with, so confirming runs
 * `setup` there and then. A paired one has neither yet: its answer is carried
 * into the bootstrap run, where `setup` is one of four steps over a channel
 * that only exists for the length of it.
 */

import type { Environment, RuntimeSetupBody } from '@mangostudio/shared/environments';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_MD } from '@/lib/icon-sizes';
import { resolveApiErrorMessage } from '@/lib/utils';

import { RuntimeConsentDialog } from '../components/RuntimeConsentDialog';
import { useRuntimeSetupMutation } from '../queries';
import { StepActions } from './StepActions';
import type { OnboardingEndState } from './steps';

interface PermissionsStepProps {
  readonly host: string;
  readonly consent: RuntimeSetupBody | null;
  readonly environment: Environment | undefined;
  readonly endState: OnboardingEndState;
  readonly onConsent: (consent: RuntimeSetupBody) => void;
  readonly onContinue: () => void;
}

export function PermissionsStep({
  host,
  consent,
  environment,
  endState,
  onConsent,
  onContinue,
}: PermissionsStepProps) {
  const { t } = useI18n();
  const labels = t.environments.onboarding;
  const profiles = t.environments.entities.permissions.profile;
  const setup = useRuntimeSetupMutation(environment?.id ?? '');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async (input: RuntimeSetupBody) => {
    setError(null);
    if (endState === 'paired') {
      onConsent(input);
      setOpen(false);
      return;
    }
    try {
      await setup.mutateAsync(input);
      onConsent(input);
      setOpen(false);
    } catch (caught) {
      setError(resolveApiErrorMessage(caught, t.environments.entities.runtime.actionFailed));
    }
  };

  return (
    <div className="space-y-4" data-testid="onboarding-permissions-step">
      <p className="text-sm text-fg-muted">
        {endState === 'paired' ? labels.permissionsPairedIntro : labels.permissionsSshIntro}
      </p>

      <div className="flex items-center justify-between gap-3 rounded-md border border-stroke p-3">
        <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-fg">
          <ShieldCheck size={ICON_MD} className="shrink-0 text-fg-muted" aria-hidden="true" />
          {consent
            ? formatMessage(labels.permissionsChosen, { profile: profiles[consent.profile] })
            : labels.permissionsNone}
        </p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setOpen(true)}
          data-testid="onboarding-open-consent"
          className="shrink-0"
        >
          {consent ? labels.permissionsChange : labels.permissionsChoose}
        </Button>
      </div>

      {open ? (
        <RuntimeConsentDialog
          machineName={host || (environment?.name ?? '')}
          initialProfile={consent?.profile ?? 'full'}
          initialAllow={consent?.profile === 'custom' ? consent.allow : undefined}
          isPending={setup.isPending}
          onCancel={() => setOpen(false)}
          onConfirm={(input) => void confirm(input)}
        />
      ) : null}

      {error ? (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      ) : null}

      <StepActions
        continueLabel={labels.continue}
        continueDisabled={consent === null}
        onContinue={onContinue}
      />
    </div>
  );
}
