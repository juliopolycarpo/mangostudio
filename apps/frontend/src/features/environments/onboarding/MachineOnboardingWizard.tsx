/**
 * One flow from an ssh string to a working environment.
 *
 * Every step calls something an earlier surface already ships — the push, the
 * consent dialog, probing, the propagation wizard — so what lives here is
 * sequencing, resume and copy, not a second implementation of any of them. A
 * step that needed its own primitive would belong on the card instead.
 *
 * The flow can be left at any point: the environment row is created at the end
 * state step and everything after it is idempotent, so an abandoned run leaves
 * a half-configured machine with all of its card's normal actions rather than
 * something only this wizard can finish.
 */

import type { Environment, RuntimeSetupBody } from '@mangostudio/shared/environments';
import { useId, useState } from 'react';

import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { useEnvironmentEntitiesQuery, useRuntimeLifecycleQuery } from '../queries';
import type { SshFormFields } from '../ssh-form';
import { emptySshForm } from '../ssh-form';
import { EndStateStep } from './EndStateStep';
import { LibraryStep } from './LibraryStep';
import { PermissionsStep } from './PermissionsStep';
import { ProvisionStep } from './ProvisionStep';
import { ReachStep } from './ReachStep';
import { SummaryStep } from './SummaryStep';
import {
  deriveOnboardingStep,
  endStateOf,
  type OnboardingEndState,
  type OnboardingStepId,
  onboardingSteps,
} from './steps';
import { ToolsStep } from './ToolsStep';

interface MachineOnboardingWizardProps {
  /** Set when the flow is re-entered for a machine it already created. */
  readonly environmentId?: string;
  readonly onClose: () => void;
}

export function MachineOnboardingWizard({ environmentId, onClose }: MachineOnboardingWizardProps) {
  const { t } = useI18n();
  const labels = t.environments.onboarding;
  const titleId = useId();

  const environments = useEnvironmentEntitiesQuery();
  const [createdId, setCreatedId] = useState<string | null>(environmentId ?? null);
  const environment = (environments.data ?? []).find((entry) => entry.id === createdId);

  const [ssh, setSsh] = useState<SshFormFields>(emptySshForm());
  const [endState, setEndState] = useState<OnboardingEndState>(
    environment ? endStateOf(environment.transportKind) : 'ssh'
  );
  const [consent, setConsent] = useState<RuntimeSetupBody | null>(null);
  const [step, setStep] = useState<OnboardingStepId>('reach');
  const [resumed, setResumed] = useState(!environmentId);

  const lifecycle = useRuntimeLifecycleQuery(createdId ?? '', Boolean(createdId));
  const steps = onboardingSteps(endState);

  // Resume lands on the first unfinished step exactly once, and only for a flow
  // re-entered against an existing row: after that the user is driving, and
  // rewriting their position when a poll lands would fight them for the wizard.
  if (!resumed && environment && (lifecycle.data || environment.transportKind === 'websocket')) {
    setResumed(true);
    setEndState(endStateOf(environment.transportKind));
    setStep(
      deriveOnboardingStep({
        transportKind: environment.transportKind,
        connected: environment.status.state === 'connected',
        health: lifecycle.data?.health ?? null,
        probed: Boolean(environment.status.manifest),
      })
    );
  }

  const index = Math.max(0, steps.indexOf(step));
  const goTo = (next: OnboardingStepId) => setStep(next);
  const advance = () => {
    const next = steps[index + 1];
    if (next) setStep(next);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape is delegated from the overlay to whatever inside it holds focus.
    <div
      className="fixed inset-0 z-50 flex animate-in items-center justify-center bg-background/80 p-4 fade-in backdrop-blur-sm duration-200"
      data-testid="machine-onboarding-wizard"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-full w-full max-w-lg space-y-5 overflow-y-auto rounded-3xl border border-outline-variant/20 bg-surface-container-high p-5 shadow-2xl sm:p-8"
      >
        <div className="space-y-1">
          <h3 id={titleId} className="font-bold text-lg text-on-surface">
            {labels.title}
          </h3>
          <p className="text-on-surface-variant/60 text-xs">
            {formatMessage(labels.progress, {
              step: String(index + 1),
              total: String(steps.length),
              name: labels.steps[step],
            })}
          </p>
        </div>

        <ol className="flex list-none flex-wrap gap-1.5" aria-label={labels.title}>
          {steps.map((candidate, position) => (
            <li
              key={candidate}
              aria-current={candidate === step ? 'step' : undefined}
              className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                position < index
                  ? 'bg-primary/10 text-primary'
                  : candidate === step
                    ? 'bg-primary/15 text-primary'
                    : 'bg-surface-container-lowest text-on-surface-variant/50'
              }`}
            >
              {labels.steps[candidate]}
            </li>
          ))}
        </ol>

        <StepBody
          step={step}
          ssh={ssh}
          endState={endState}
          consent={consent}
          environment={environment}
          onSsh={setSsh}
          onEndState={setEndState}
          onConsent={setConsent}
          onCreated={setCreatedId}
          onAdvance={advance}
          onGoTo={goTo}
          onClose={onClose}
        />
      </div>
    </div>
  );
}

interface StepBodyProps {
  readonly step: OnboardingStepId;
  readonly ssh: SshFormFields;
  readonly endState: OnboardingEndState;
  readonly consent: RuntimeSetupBody | null;
  readonly environment: Environment | undefined;
  readonly onSsh: (fields: SshFormFields) => void;
  readonly onEndState: (endState: OnboardingEndState) => void;
  readonly onConsent: (consent: RuntimeSetupBody) => void;
  readonly onCreated: (environmentId: string) => void;
  readonly onAdvance: () => void;
  readonly onGoTo: (step: OnboardingStepId) => void;
  readonly onClose: () => void;
}

function StepBody(props: StepBodyProps) {
  const { t } = useI18n();
  const labels = t.environments.onboarding;

  switch (props.step) {
    case 'reach':
      return <ReachStep form={props.ssh} onChange={props.onSsh} onContinue={props.onAdvance} />;
    case 'end-state':
      return (
        <EndStateStep
          ssh={props.ssh}
          endState={props.endState}
          existing={props.environment}
          onEndState={props.onEndState}
          onCreated={props.onCreated}
          onContinue={props.onAdvance}
          onBack={() => props.onGoTo('reach')}
        />
      );
    case 'permissions':
      return (
        <PermissionsStep
          host={props.ssh.host || (props.environment?.name ?? '')}
          consent={props.consent}
          environment={props.environment}
          endState={props.endState}
          onConsent={props.onConsent}
          onContinue={props.onAdvance}
        />
      );
    case 'install':
    case 'provision':
      return props.environment ? (
        <ProvisionStep
          environment={props.environment}
          endState={props.endState}
          ssh={props.ssh}
          consent={props.consent}
          onContinue={props.onAdvance}
        />
      ) : (
        <MissingEnvironment message={labels.missingEnvironment} />
      );
    case 'tools':
      return props.environment ? (
        <ToolsStep environment={props.environment} onContinue={props.onAdvance} />
      ) : (
        <MissingEnvironment message={labels.missingEnvironment} />
      );
    case 'library':
      return props.environment ? (
        <LibraryStep environment={props.environment} onContinue={props.onAdvance} />
      ) : (
        <MissingEnvironment message={labels.missingEnvironment} />
      );
    case 'done':
      return props.environment ? (
        <SummaryStep
          environment={props.environment}
          endState={props.endState}
          onDone={props.onClose}
        />
      ) : (
        <MissingEnvironment message={labels.missingEnvironment} />
      );
    default: {
      const exhaustive: never = props.step;
      return exhaustive;
    }
  }
}

/**
 * Every post-creation step needs the same row from the list query. It can go
 * missing mid-flow — deleted elsewhere, or dropped from a later page — and
 * silence at that point reads as a stuck wizard rather than the explanation.
 */
function MissingEnvironment({ message }: { readonly message: string }) {
  return (
    <p className="text-error text-xs" role="alert">
      {message}
    </p>
  );
}
