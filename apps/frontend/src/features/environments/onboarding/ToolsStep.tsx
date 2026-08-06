/**
 * What is on the machine, and whether MangoStudio may add to it.
 *
 * Probing runs by itself once the runtime answers; this only shows what came
 * back. Installing is a separate answer, and it renders as its own line rather
 * than as a box already ticked — the machine's own consent and this switch have
 * to agree before a recipe runs, and a default that pre-agrees on one side is
 * not a default, it is a decision taken on somebody's behalf.
 */

import type { Environment, RuntimeStatus } from '@mangostudio/shared/environments';
import { useQuery } from '@tanstack/react-query';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { InstallTrustToggle } from '../components/InstallTrustToggle';
import { effectiveInstallation } from '../format';
import { agentCliStatusesQueryOptions, runtimeStatusesQueryOptions } from '../queries';
import { StepActions } from './StepActions';

interface ToolsStepProps {
  readonly environment: Environment;
  readonly onContinue: () => void;
}

export function ToolsStep({ environment, onContinue }: ToolsStepProps) {
  const { t } = useI18n();
  const labels = t.environments.onboarding;
  const connected = environment.status.state === 'connected';
  const runtimes = useQuery({
    ...runtimeStatusesQueryOptions(environment.id),
    enabled: connected,
  });
  const agents = useQuery({
    ...agentCliStatusesQueryOptions(environment.id),
    enabled: connected,
  });

  // The version shown is the effective one — the binary a shell over there
  // would actually reach — for the same reason the overview strip shows it.
  const found = [...(runtimes.data ?? []), ...(agents.data ?? [])]
    .filter((entry) => entry.health !== 'missing')
    .map((entry: RuntimeStatus) => {
      const { installation } = effectiveInstallation(entry);
      return installation ? `${entry.id} ${installation.version}` : entry.id;
    });

  return (
    <div className="space-y-4" data-testid="onboarding-tools-step">
      <p className="text-on-surface-variant/70 text-xs">{labels.toolsIntro}</p>

      {!connected ? (
        <p className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest/60 px-3 py-2.5 text-on-surface-variant/70 text-xs">
          {labels.toolsDisconnected}
        </p>
      ) : runtimes.isPending || agents.isPending ? (
        <p className="text-on-surface-variant/50 text-xs">{labels.toolsProbing}</p>
      ) : found.length === 0 ? (
        <p className="text-on-surface-variant/70 text-xs">{labels.toolsNone}</p>
      ) : (
        <ul className="flex list-none flex-wrap gap-1.5" aria-label={labels.toolsIntro}>
          {found.map((name) => (
            <li
              key={name}
              className="rounded-md border border-outline-variant/15 bg-surface-container-lowest px-2 py-1 font-mono text-[10px] text-on-surface-variant"
            >
              {name}
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest/60 px-3 py-2.5">
        <InstallTrustToggle environment={environment} />
        <p className="mt-1.5 text-on-surface-variant/60 text-xs">
          {formatMessage(labels.toolsInstallsNote, { name: environment.name })}
        </p>
      </div>

      <StepActions continueLabel={labels.continue} onContinue={onContinue} />
    </div>
  );
}
