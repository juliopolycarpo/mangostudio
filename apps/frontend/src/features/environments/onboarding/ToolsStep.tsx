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

import { Callout } from '@/components/ui/Callout';
import { Chip } from '@/components/ui/Chip';
import { Spinner } from '@/components/ui/Spinner';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';

import { InstallTrustToggle } from '../components/InstallTrustToggle';
import { effectiveInstallation, versionLabel } from '../format';
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
      return { id: entry.id, version: installation ? versionLabel(t, installation.version) : null };
    });

  return (
    <div className="space-y-4" data-testid="onboarding-tools-step">
      <p className="text-sm text-fg-muted">{labels.toolsIntro}</p>

      {!connected ? (
        <Callout tone="info">{labels.toolsDisconnected}</Callout>
      ) : runtimes.isPending || agents.isPending ? (
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <Spinner size="sm" />
          {labels.toolsProbing}
        </div>
      ) : runtimes.isError || agents.isError ? (
        <Callout tone="danger" role="alert">
          {labels.toolsError}
        </Callout>
      ) : found.length === 0 ? (
        <p className="text-sm text-fg-muted">{labels.toolsNone}</p>
      ) : (
        <ul className="flex list-none flex-wrap gap-2" aria-label={labels.toolsIntro}>
          {found.map((tool) => (
            <li key={`${tool.id}:${tool.version ?? ''}`}>
              {tool.version === null ? (
                <Chip>{tool.id}</Chip>
              ) : (
                <Chip label={tool.id}>{tool.version}</Chip>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2 rounded-md border border-stroke p-3">
        <InstallTrustToggle environment={environment} />
        <p className="text-xs text-fg-muted">
          {formatMessage(labels.toolsInstallsNote, { name: environment.name })}
        </p>
      </div>

      <StepActions continueLabel={labels.continue} onContinue={onContinue} />
    </div>
  );
}
