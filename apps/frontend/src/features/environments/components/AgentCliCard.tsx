/**
 * One agent CLI: version, config home, auth state, and the Library locations it
 * reads and writes.
 */

import type { AgentCliStatus, InstallRecipePreview } from '@mangostudio/shared/environments';
import type { Messages } from '@mangostudio/shared/i18n';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import {
  findInstallRecipe,
  prefixedVersionLabel,
  runtimeUninstallRecipe,
  stepFor,
} from '../format';
import { useProbeAgentCli } from '../hooks/use-runtime-status';
import { useToolIdentities } from '../identity/use-tool-identities';
import { AgentAuthState } from './AgentAuthState';
import { FindingList } from './FindingList';
import { HealthBadge } from './HealthBadge';
import { ProbeButton } from './ProbeButton';
import { RecipeAction } from './RecipeAction';
import { ToolCard } from './ToolCard';

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
  const installStep = stepFor(findInstallRecipe(recipes, status.id, 'install'));
  const updateStep = stepFor(findInstallRecipe(recipes, status.id, 'update'));
  const uninstallStep = stepFor(runtimeUninstallRecipe(status, recipes));

  return (
    <ToolCard
      kind="agent"
      id={status.targetId}
      testId="agent-cli-card"
      dataAttributes={{ 'data-target-id': status.targetId }}
      subtitle={
        <p className="text-xs text-fg-muted">
          {status.effective
            ? prefixedVersionLabel(t, status.effective.version)
            : e.agents.notInstalled}
        </p>
      }
      actions={
        <>
          <HealthBadge health={status.health} />
          <AgentAuthState status={status} />
          <ProbeButton
            isPending={probe.isPending}
            isError={probe.isError}
            onProbe={() => probe.mutate(status.targetId)}
          />
        </>
      }
      // Install when nothing runs yet; update and/or uninstall once it does.
      // Decided on the steps, never on the rendered nodes: a `RecipeAction`
      // with no step renders nothing but is still a truthy element, so
      // handing one to `footer` would open a footer with a gap and no button.
      footer={
        !status.effective ? (
          installStep ? (
            <RecipeAction
              step={installStep}
              action="install"
              catalog={recipes}
              name={name}
              environmentId={environmentId}
            />
          ) : null
        ) : updateStep || uninstallStep ? (
          <>
            <RecipeAction
              step={updateStep}
              action="update"
              catalog={recipes}
              name={name}
              environmentId={environmentId}
            />
            <RecipeAction
              step={uninstallStep}
              action="uninstall"
              catalog={recipes}
              name={name}
              environmentId={environmentId}
            />
          </>
        ) : null
      }
    >
      <dl className="grid items-baseline gap-2 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4">
        <dt className="text-fg-muted">{e.agents.configHomeLabel}</dt>
        <dd className="min-w-0 break-all font-mono text-xs text-fg-muted">{status.configHome}</dd>
      </dl>

      {/* What "unknown" means, in the open: the badge says it, this says why. */}
      {status.authSignal === 'unknown' && (
        <p className="text-xs text-fg-muted">{e.agents.authUnknownHint}</p>
      )}

      <FindingList findings={status.findings} />

      {status.locations.length > 0 && (
        <section className="space-y-2">
          <MicroLabel as="p">{e.agents.locations}</MicroLabel>
          {/* Path, state, count: three columns shared by every row, so "writable" and
              "4 entries" start at the same x on each of them. Each row takes the
              columns over through a subgrid and stays a list item. */}
          <ul className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-4 gap-y-1.5 text-xs">
            {status.locations.map((location) => (
              <li
                key={location.id}
                className="col-span-3 grid grid-cols-subgrid items-baseline"
                data-testid="library-location"
              >
                <span className="min-w-0 break-all font-mono text-fg-muted">
                  {location.path ?? location.id}
                </span>
                <span className="text-fg-muted">{locationState(e, location)}</span>
                <span className="text-fg-muted">
                  {location.entryCount !== undefined
                    ? formatMessage(e.agents.locationEntries, {
                        count: String(location.entryCount),
                      })
                    : null}
                </span>
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
