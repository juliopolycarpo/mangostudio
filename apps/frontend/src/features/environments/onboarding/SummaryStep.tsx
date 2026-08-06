/**
 * What was done, and the commands to check it with.
 *
 * The two lines at the bottom are not decoration. Everything above them
 * happened on somebody's machine on their credentials, and the person who owns
 * it should be able to audit that without taking a web page's word for it — so
 * the summary hands over exactly what to run there.
 *
 * Every field is read live rather than remembered from the run: a wizard that
 * reported its own intentions would keep claiming a machine is connected long
 * after it stopped being.
 */

import type { Environment } from '@mangostudio/shared/environments';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { CopyLine } from '../components/CopyLine';
import { useRuntimeLifecycleQuery } from '../queries';
import { StepActions } from './StepActions';
import type { OnboardingEndState } from './steps';

interface SummaryStepProps {
  readonly environment: Environment;
  readonly endState: OnboardingEndState;
  readonly onDone: () => void;
}

export function SummaryStep({ environment, endState, onDone }: SummaryStepProps) {
  const { t } = useI18n();
  const labels = t.environments.onboarding;
  const entities = t.environments.entities;
  const lifecycle = useRuntimeLifecycleQuery(environment.id);
  const health = lifecycle.data?.health ?? null;
  const connected = environment.status.state === 'connected';

  const rows: readonly { readonly label: string; readonly value: string }[] = [
    { label: labels.summaryTransport, value: entities.transport[environment.transportKind] },
    { label: labels.summaryStatus, value: entities.status[environment.status.state] },
    {
      label: labels.summaryVersion,
      value: health?.version ?? health?.runtimeVersion ?? labels.summaryUnknown,
    },
    {
      label: labels.summaryDigest,
      value: health?.digest ? health.digest.slice(0, 15) : labels.summaryUnknown,
    },
    {
      label: labels.summaryProfile,
      value: health ? entities.permissions.profile[health.profile] : labels.summaryUnknown,
    },
  ];

  return (
    <div className="space-y-4" data-testid="onboarding-summary-step">
      <p className="text-on-surface-variant/70 text-xs">
        {formatMessage(connected ? labels.summaryReady : labels.summaryPending, {
          name: environment.name,
        })}
      </p>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-xl border border-outline-variant/20 bg-surface-container-lowest/60 px-3 py-2.5">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-on-surface-variant/60 text-xs">{row.label}</dt>
            <dd className="truncate font-mono text-[11px] text-on-surface-variant">{row.value}</dd>
          </div>
        ))}
      </dl>

      <div className="space-y-2">
        <p className="text-on-surface-variant/70 text-xs">{labels.summaryAudit}</p>
        <CopyLine
          label={entities.permissions.setupCommand}
          value="mangostudio-runtime setup --slot remote"
        />
        {endState === 'paired' ? (
          <CopyLine
            label={labels.summaryServiceCommand}
            value="mangostudio-runtime service status"
          />
        ) : null}
      </div>

      <StepActions continueLabel={labels.finish} onContinue={onDone} />
    </div>
  );
}
