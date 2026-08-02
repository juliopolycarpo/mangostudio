/**
 * One agent CLI as the overview shows it: who it is, whether it works, and the
 * single worst thing wrong with it.
 *
 * The full card on the Agents tab is the place for config homes and library
 * locations. This one answers "can I use this right now" and hands the rest to
 * the link at the bottom, so a grid of them stays scannable.
 */

import type { AgentCliStatus, InstallRecipePreview } from '@mangostudio/shared/environments';
import { Link } from '@tanstack/react-router';
import { Download } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { describeFinding, findInstallRecipe, findingSeverity, worstFinding } from '../format';
import { useProbeAgentCli } from '../hooks/use-runtime-status';
import { useToolIdentities } from '../identity/use-tool-identities';
import { useEnvironmentEntitiesQuery } from '../queries';
import { AgentAuthState } from './AgentAuthState';
import { AgentPresenceChips } from './AgentPresenceChips';
import { FindingIcon } from './FindingList';
import { HealthBadge } from './HealthBadge';
import { InstallAction } from './InstallAction';
import { ProbeButton } from './ProbeButton';
import { ToolCard } from './ToolCard';

interface OverviewAgentCardProps {
  readonly status: AgentCliStatus;
  readonly recipes: readonly InstallRecipePreview[];
}

export function OverviewAgentCard({ status, recipes }: OverviewAgentCardProps) {
  const { t } = useI18n();
  const e = t.environments;
  const probe = useProbeAgentCli();
  const { resolve, lookup } = useToolIdentities();
  const environments = useEnvironmentEntitiesQuery();
  const name = resolve('agent', status.targetId).name;
  const installRecipe = findInstallRecipe(recipes, status.id, 'install');
  const finding = worstFinding(status.findings);

  return (
    <ToolCard
      kind="agent"
      id={status.targetId}
      avatarSize="lg"
      testId="overview-agent-card"
      dataAttributes={{ 'data-target-id': status.targetId }}
      subtitle={
        <p className="text-xs text-on-surface-variant/60">
          {status.effective
            ? `${e.agents.versionLabel} ${status.effective.version}`
            : e.agents.notInstalled}
        </p>
      }
      actions={<HealthBadge health={status.health} />}
      footer={
        <>
          <ProbeButton
            isPending={probe.isPending}
            isError={probe.isError}
            onProbe={() => probe.mutate(status.targetId)}
          />
          {!status.effective && installRecipe && (
            <InstallAction
              recipe={installRecipe}
              input={{ kind: 'none' }}
              label={formatMessage(e.runtimes.install, { runtime: name })}
              variant="primary"
              icon={<Download size={14} />}
            />
          )}
          <Link
            to="/environments/agents"
            className="ml-auto rounded-lg px-2 py-1 text-sm text-on-surface-variant/70 transition-colors hover:bg-surface-container-highest hover:text-primary"
          >
            {e.overview.agentDetails}
          </Link>
        </>
      }
    >
      <AgentAuthState status={status} showHint={false} />

      <AgentPresenceChips targetId={status.targetId} environments={environments.data ?? []} />

      {/* One line for the worst finding, because a card with room for one has
          to spend it on what actually stops the agent from working. */}
      {finding && (
        <div
          className="flex items-start gap-2"
          data-testid="overview-agent-finding"
          data-finding-code={finding.code}
        >
          <FindingIcon severity={findingSeverity(finding)} size={14} />
          <p className="text-xs text-on-surface-variant">{describeFinding(t, finding, lookup)}</p>
        </div>
      )}
    </ToolCard>
  );
}
