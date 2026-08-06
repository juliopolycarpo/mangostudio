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
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
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
      <p className="text-on-surface-variant/70 text-xs">
        {endState === 'paired' ? labels.permissionsPairedIntro : labels.permissionsSshIntro}
      </p>

      <div className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest/60 px-3 py-2.5">
        <p className="flex items-center gap-1.5 font-semibold text-on-surface text-sm">
          <ShieldCheck size={14} className="text-primary/80" aria-hidden="true" />
          {consent
            ? formatMessage(labels.permissionsChosen, { profile: profiles[consent.profile] })
            : labels.permissionsNone}
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-testid="onboarding-open-consent"
          className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-lg bg-primary/10 px-2 font-semibold text-[11px] text-primary transition-colors hover:bg-primary/15"
        >
          {consent ? labels.permissionsChange : labels.permissionsChoose}
        </button>
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
        <p className="text-error text-xs" role="alert">
          {error}
        </p>
      ) : null}

      <StepActions
        continueLabel={labels.continue}
        continueDisabled={consent === null}
        onContinue={onContinue}
      />
    </div>
  );
}
