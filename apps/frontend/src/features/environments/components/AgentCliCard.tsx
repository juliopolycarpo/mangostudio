/**
 * One agent CLI: version, config home, auth state, and the Library locations it
 * reads and writes.
 */

import type { AgentCliStatus, InstallRecipePreview } from '@mangostudio/shared/environments';
import type { Messages } from '@mangostudio/shared/i18n';
import { Download } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { findInstallRecipe, prefixedVersionLabel } from '../format';
import { useProbeAgentCli } from '../hooks/use-runtime-status';
import { useToolIdentities } from '../identity/use-tool-identities';
import { AgentAuthState } from './AgentAuthState';
import { FindingList } from './FindingList';
import { HealthBadge } from './HealthBadge';
import { InstallAction } from './InstallAction';
import { ProbeButton } from './ProbeButton';
import { CardSectionLabel, ToolCard } from './ToolCard';

interface AgentCliCardProps {
  status: AgentCliStatus;
  recipes: readonly InstallRecipePreview[];
  /** The machine this card is about; a re-check has to go back to the same one. */
  environmentId?: string;
}

export function AgentCliCard({ status, recipes, environmentId }: AgentCliCardProps) {
  const { t } = useI18n();
  const e = t.environments;
  const probe = useProbeAgentCli(environmentId);
  const { resolve } = useToolIdentities();
  const name = resolve('agent', status.targetId).name;
  const installRecipe = findInstallRecipe(recipes, status.id, 'install');

  return (
    <ToolCard
      kind="agent"
      id={status.targetId}
      testId="agent-cli-card"
      dataAttributes={{ 'data-target-id': status.targetId }}
      subtitle={
        <p className="text-xs text-on-surface-variant/60">
          {status.effective
            ? prefixedVersionLabel(t, status.effective.version)
            : e.agents.notInstalled}
        </p>
      }
      actions={
        <>
          <HealthBadge health={status.health} />
          <ProbeButton
            isPending={probe.isPending}
            isError={probe.isError}
            onProbe={() => probe.mutate(status.targetId)}
          />
        </>
      }
      footer={
        !status.effective && installRecipe ? (
          <InstallAction
            recipe={installRecipe}
            catalog={recipes}
            input={{ kind: 'none' }}
            label={formatMessage(e.runtimes.install, { runtime: name })}
            variant="primary"
            icon={<Download size={14} />}
            environmentId={environmentId}
          />
        ) : null
      }
    >
      <dl className="grid gap-2 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4">
        <dt className="text-on-surface-variant/60">{e.agents.configHomeLabel}</dt>
        <dd className="min-w-0 break-all font-mono text-xs text-on-surface-variant">
          {status.configHome}
        </dd>
      </dl>

      <AgentAuthState status={status} />

      <FindingList findings={status.findings} />

      {status.locations.length > 0 && (
        <section className="space-y-2">
          <CardSectionLabel>{e.agents.locations}</CardSectionLabel>
          <ul className="space-y-1.5">
            {status.locations.map((location) => (
              <li
                key={location.id}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs"
                data-testid="library-location"
              >
                <span className="min-w-0 break-all font-mono text-on-surface-variant">
                  {location.path ?? location.id}
                </span>
                <span className="text-on-surface-variant/60">{locationState(e, location)}</span>
                {location.entryCount !== undefined && (
                  <span className="text-on-surface-variant/60">
                    {formatMessage(e.agents.locationEntries, {
                      count: String(location.entryCount),
                    })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </ToolCard>
  );
}

function locationState(
  e: Messages['environments'],
  location: AgentCliStatus['locations'][number]
): string {
  if (location.path === null) return e.agents.locationUnsupported;
  if (!location.exists) return e.agents.locationMissing;
  return location.writable ? e.agents.locationWritable : e.agents.locationReadOnly;
}
