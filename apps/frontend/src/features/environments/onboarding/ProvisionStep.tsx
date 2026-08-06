/**
 * The step that touches the machine, over the console the card already uses.
 *
 * Which run it starts is the whole difference between the two end states. An
 * ssh environment gets 020's push and nothing else — its consent is a separate
 * hub action against a stored config, and probing follows once it connects. A
 * paired one has no stored config to act against, so one run does the push, the
 * consent, the credential and the service over a channel that exists only while
 * it lasts.
 *
 * A run that ends badly is not a dead end: the environment row, whatever
 * landed on the machine and the card's own actions all survive it, and the
 * console holds the reason in the words 013 and 023 wrote for it.
 */

import type { Environment, RuntimeSetupBody } from '@mangostudio/shared/environments';
import { useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { resolveApiErrorMessage } from '@/lib/utils';
import { InstallConsole } from '../components/InstallConsole';
import { useInstallStream } from '../hooks/use-install-stream';
import {
  useCancelRuntimeInstallMutation,
  useRuntimeLifecycleQuery,
  useStartPairedBootstrapMutation,
  useStartRuntimeInstallMutation,
} from '../queries';
import type { SshFormFields } from '../ssh-form';
import { sshFormToConfig } from '../ssh-form';
import { StepActions } from './StepActions';
import type { OnboardingEndState } from './steps';

interface ProvisionStepProps {
  readonly environment: Environment;
  readonly endState: OnboardingEndState;
  readonly ssh: SshFormFields;
  readonly consent: RuntimeSetupBody | null;
  readonly onContinue: () => void;
}

export function ProvisionStep({
  environment,
  endState,
  ssh,
  consent,
  onContinue,
}: ProvisionStepProps) {
  const { t } = useI18n();
  const labels = t.environments.onboarding;
  const install = useStartRuntimeInstallMutation(environment.id);
  const bootstrap = useStartPairedBootstrapMutation(environment.id);
  const cancel = useCancelRuntimeInstallMutation(environment.id);
  const lifecycle = useRuntimeLifecycleQuery(environment.id);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stream = useInstallStream({
    runId,
    streamPath: runId
      ? `/api/environments/${encodeURIComponent(environment.id)}/runtime/runs/${encodeURIComponent(runId)}/log`
      : null,
    onExit: () => {
      void lifecycle.refetch();
    },
  });

  const paired = endState === 'paired';
  const running = Boolean(
    runId && stream.phase !== 'finished' && stream.phase !== 'failed' && stream.phase !== 'idle'
  );
  const finished = stream.phase === 'finished' && stream.exit?.status === 'succeeded';

  const start = async () => {
    setError(null);
    try {
      const started = paired
        ? await bootstrap.mutateAsync({
            ssh: sshFormToConfig(ssh),
            consent: requireConsent(consent),
          })
        : await install.mutateAsync('install');
      setRunId(started.runId);
    } catch (caught) {
      setError(resolveApiErrorMessage(caught, t.environments.entities.runtime.actionFailed));
    }
  };

  return (
    <div className="space-y-4" data-testid="onboarding-provision-step">
      <p className="text-on-surface-variant/70 text-xs">
        {paired ? labels.provisionPairedIntro : labels.provisionSshIntro}
      </p>

      {runId ? null : (
        <button
          type="button"
          disabled={install.isPending || bootstrap.isPending}
          onClick={() => void start()}
          data-testid="onboarding-provision-start"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary/10 px-2.5 font-semibold text-primary text-xs transition-colors hover:bg-primary/15 disabled:opacity-45"
        >
          {paired ? labels.provisionStartPaired : labels.provisionStartSsh}
        </button>
      )}

      {error ? (
        <p className="text-error text-xs" role="alert">
          {error}
        </p>
      ) : null}

      {runId ? (
        <InstallConsole
          stream={stream}
          onCancel={() => {
            void cancel.mutateAsync(runId).catch(() => undefined);
            setRunId(null);
          }}
          onClose={() => setRunId(null)}
        />
      ) : null}

      <StepActions
        continueLabel={labels.continue}
        continueDisabled={running || (!finished && runId !== null)}
        onContinue={onContinue}
      />
    </div>
  );
}

/**
 * The paired body cannot be assembled without a consent answer, and the flow
 * asks for one the step before. Reaching here without it is a wiring mistake,
 * not a state a user can produce.
 */
function requireConsent(consent: RuntimeSetupBody | null): RuntimeSetupBody {
  if (!consent) throw new Error('Consent was not recorded before provisioning.');
  return consent;
}
