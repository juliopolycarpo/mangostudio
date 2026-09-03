/**
 * One runtime: which binary actually runs, what is wrong with that, and the fix.
 *
 * The effective installation leads the card because "which node runs" is the
 * question the page exists to answer; the installation list below is evidence,
 * not the headline.
 */

import type { InstallRecipePreview, RuntimeStatus } from '@mangostudio/shared/environments';
import type { Messages } from '@mangostudio/shared/i18n';
import { Download } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import {
  effectiveInstallation,
  findInstallRecipe,
  type IdentityResolver,
  type NodeUpdateAffordance,
  nodeInstallStep,
  nodeUpdateAffordance,
  pathPosition,
  pathSourceLabel,
  pathSourceManagerName,
  versionLabel,
} from '../format';
import { useProbeRuntime } from '../hooks/use-runtime-status';
import { useToolIdentities } from '../identity/use-tool-identities';
import { FindingList } from './FindingList';
import { HealthBadge } from './HealthBadge';
import { InstallAction } from './InstallAction';
import { InstallationList } from './InstallationList';
import { ProbeButton } from './ProbeButton';
import { CardSectionLabel, ToolCard } from './ToolCard';

interface RuntimeCardProps {
  status: RuntimeStatus;
  recipes: readonly InstallRecipePreview[];
  /** The machine this card is about; a re-check has to go back to the same one. */
  environmentId?: string;
  children?: React.ReactNode;
}

export function RuntimeCard({ status, recipes, environmentId, children }: RuntimeCardProps) {
  const { t } = useI18n();
  const e = t.environments;
  const probe = useProbeRuntime(environmentId);
  const { resolve } = useToolIdentities();
  const name = resolve('runtime', status.id).name;
  const isNode = status.id === 'node';

  const { groups, group: effectiveGroup, installation: effective } = effectiveInstallation(status);

  const installAction = isNode
    ? renderNodeInstall(recipes, name, environmentId, e)
    : renderGenericInstall(recipes, status.id, name, environmentId, e);

  const updateAffordance = isNode
    ? renderNodeUpdate(
        nodeUpdateAffordance(status, recipes),
        recipes,
        name,
        environmentId,
        t,
        resolve
      )
    : renderGenericUpdate(recipes, status.id, name, environmentId, e);

  const uninstallRecipe = findInstallRecipe(recipes, status.id, 'uninstall');
  const uninstallAction = uninstallRecipe && (
    <InstallAction
      recipe={uninstallRecipe}
      catalog={recipes}
      input={{ kind: 'none' }}
      label={formatMessage(e.runtimes.uninstall, { runtime: name })}
      variant="ghost"
      environmentId={environmentId}
    />
  );

  const hasInstalledFooter = Boolean(updateAffordance) || Boolean(uninstallAction);

  return (
    <ToolCard
      kind="runtime"
      id={status.id}
      testId="runtime-card"
      dataAttributes={{ 'data-runtime-id': status.id }}
      subtitle={runtimeSubtitle(status, groups, e)}
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
      // Install, or update/uninstall, never both — and nothing at all when the
      // registry offers neither. A fragment would always be truthy, so the card
      // would close on an empty footer and the gap above it.
      footer={
        status.installations.length === 0 ? (
          installAction
        ) : hasInstalledFooter ? (
          <>
            {updateAffordance}
            {uninstallAction}
          </>
        ) : null
      }
    >
      {effective ? (
        <section className="space-y-1" data-testid="effective-installation">
          <CardSectionLabel>{e.runtimes.effectiveLabel}</CardSectionLabel>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-base font-semibold text-on-surface">
              {versionLabel(t, effective.version)}
            </span>
            <span className="min-w-0 break-all font-mono text-xs text-on-surface-variant/70">
              {effective.rawPath}
            </span>
          </div>
          <p className="text-xs text-on-surface-variant/60">
            {[
              effective.pathIndex !== undefined
                ? formatMessage(e.runtimes.pathIndexLabel, {
                    position: String(pathPosition(effective.pathIndex)),
                  })
                : e.origins[effective.origin],
              pathSourceLabel(t, effective.pathSource),
              // A symlink chain is one row; the paths that reach it are an
              // affordance on that row, never extra rows.
              effectiveGroup && effectiveGroup.aliasCount > 1
                ? formatMessage(e.runtimes.aliasReachable, {
                    count: String(effectiveGroup.aliasCount),
                  })
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </section>
      ) : (
        <p className="text-sm text-on-surface-variant/70">
          {status.installations.length === 0
            ? formatMessage(e.runtimes.notInstalled, { runtime: name })
            : e.runtimes.noEffective}
        </p>
      )}

      <FindingList findings={status.findings} />

      {groups.length > 1 && (
        <section className="space-y-2">
          <CardSectionLabel>{e.runtimes.otherInstallations}</CardSectionLabel>
          <InstallationList groups={groups.filter((group) => !group.effective)} />
        </section>
      )}

      {children}
    </ToolCard>
  );
}

/** fnm gets an extra line saying what it is; every runtime keeps its version count. */
function runtimeSubtitle(
  status: RuntimeStatus,
  groups: ReturnType<typeof effectiveInstallation>['groups'],
  e: Messages['environments']
): React.ReactNode {
  if (status.id !== 'fnm' && groups.length === 0) return undefined;
  return (
    <div className="space-y-0.5">
      {status.id === 'fnm' && (
        <p className="text-xs text-on-surface-variant/60">{e.runtimes.nodeVersionManager}</p>
      )}
      {groups.length > 0 && (
        <p className="text-xs text-on-surface-variant/60">
          {groups.length === 1
            ? e.runtimes.singleVersion
            : formatMessage(e.runtimes.versionCount, { count: String(groups.length) })}
        </p>
      )}
    </div>
  );
}

function renderGenericInstall(
  recipes: readonly InstallRecipePreview[],
  runtimeId: string,
  name: string,
  environmentId: string | undefined,
  e: Messages['environments']
): React.ReactNode {
  const recipe = findInstallRecipe(recipes, runtimeId, 'install');
  if (!recipe) return null;
  return (
    <InstallAction
      recipe={recipe}
      catalog={recipes}
      input={{ kind: 'none' }}
      label={formatMessage(e.runtimes.install, { runtime: name })}
      variant="primary"
      icon={<Download size={14} />}
      environmentId={environmentId}
    />
  );
}

function renderNodeInstall(
  recipes: readonly InstallRecipePreview[],
  name: string,
  environmentId: string | undefined,
  e: Messages['environments']
): React.ReactNode {
  const step = nodeInstallStep(recipes);
  if (!step) return null;
  return (
    <InstallAction
      recipe={step.recipe}
      input={step.input}
      catalog={recipes}
      label={formatMessage(e.runtimes.install, { runtime: name })}
      variant="primary"
      icon={<Download size={14} />}
      environmentId={environmentId}
    />
  );
}

function renderGenericUpdate(
  recipes: readonly InstallRecipePreview[],
  runtimeId: string,
  name: string,
  environmentId: string | undefined,
  e: Messages['environments']
): React.ReactNode {
  const recipe = findInstallRecipe(recipes, runtimeId, 'update');
  if (!recipe) return null;
  return (
    <InstallAction
      recipe={recipe}
      catalog={recipes}
      input={{ kind: 'none' }}
      label={formatMessage(e.runtimes.update, { runtime: name })}
      environmentId={environmentId}
    />
  );
}

/**
 * Node's "Update" affordance is not one recipe: which chain runs — or whether
 * nothing here can touch it at all — depends on which manager put the
 * effective binary on PATH. `nodeUpdateAffordance` (format.ts) decides which
 * case this is; this only turns that decision into markup.
 */
function renderNodeUpdate(
  affordance: NodeUpdateAffordance,
  recipes: readonly InstallRecipePreview[],
  name: string,
  environmentId: string | undefined,
  t: Messages,
  resolve: IdentityResolver
): React.ReactNode {
  if (affordance.kind === 'none') return null;

  if (affordance.kind === 'managed-elsewhere') {
    // "Managed by {manager}" cannot carry a bare "the system" grammatically in
    // every locale, so a plain system install gets its own full sentence
    // instead of a name plugged into the template.
    const text =
      affordance.source === 'system'
        ? t.environments.runtimes.managedBySystem
        : formatMessage(t.environments.runtimes.managedElsewhere, {
            manager: pathSourceManagerName(t, resolve, affordance.source),
          });
    return (
      <p className="text-sm text-on-surface-variant/70" data-testid="node-managed-elsewhere">
        {text}
      </p>
    );
  }

  return (
    <InstallAction
      recipe={affordance.primary.recipe}
      input={affordance.primary.input}
      followUpSteps={affordance.followUp}
      catalog={recipes}
      label={formatMessage(t.environments.runtimes.update, { runtime: name })}
      environmentId={environmentId}
    />
  );
}
