/**
 * A compact card for a tool MangoStudio only ever checks for, never installs
 * or updates — winget, on a Windows target. It exists so the other Windows
 * recipes have somewhere to point ("winget needed"), not as a runtime with its
 * own lifecycle: there is no install button here, because MangoStudio has no
 * recipe that could ever draw one.
 */

import type { RuntimeStatus } from '@mangostudio/shared/environments';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { effectiveInstallation, versionLabel } from '../format';
import { useProbeRuntime } from '../hooks/use-runtime-status';
import { useToolIdentities } from '../identity/use-tool-identities';
import { FindingList } from './FindingList';
import { HealthBadge } from './HealthBadge';
import { ProbeButton } from './ProbeButton';
import { ToolCard } from './ToolCard';

interface PrerequisiteCardProps {
  status: RuntimeStatus;
  /** The machine this card is about; a re-check has to go back to the same one. */
  environmentId?: string;
}

export function PrerequisiteCard({ status, environmentId }: PrerequisiteCardProps) {
  const { t } = useI18n();
  const e = t.environments;
  const probe = useProbeRuntime(environmentId);
  const { resolve } = useToolIdentities();
  const name = resolve('runtime', status.id).name;
  const { installation } = effectiveInstallation(status);

  return (
    <ToolCard
      kind="runtime"
      id={status.id}
      testId="prerequisite-card"
      density="compact"
      dataAttributes={{ 'data-runtime-id': status.id }}
      subtitle={<p className="text-xs text-on-surface-variant/60">{e.runtimes.prerequisiteHint}</p>}
      actions={
        <>
          <HealthBadge health={status.health} />
          <ProbeButton
            isPending={probe.isPending}
            isError={probe.isError}
            onProbe={() => probe.mutate(status.id)}
          />
        </>
      }
    >
      <p className="text-sm text-on-surface-variant/70">
        {installation
          ? versionLabel(t, installation.version)
          : formatMessage(e.runtimes.notInstalled, { runtime: name })}
      </p>

      <FindingList findings={status.findings} />
    </ToolCard>
  );
}
