/**
 * One runtime: which binary actually runs, what is wrong with that, and the fix.
 *
 * The effective installation leads the card because "which node runs" is the
 * question the page exists to answer; the installation list below is evidence,
 * not the headline.
 */

import type {
  InstallRecipePreview,
  PathSource,
  RuntimeStatus,
} from '@mangostudio/shared/environments';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type { Messages } from '@mangostudio/shared/i18n';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { resolveApiErrorMessage } from '@/lib/utils';
import {
  effectiveInstallation,
  findInstallRecipe,
  type IdentityResolver,
  installStep,
  nodeUpdateAffordance,
  pathPosition,
  pathSourceLabel,
  pathSourceManagerName,
  runtimeUninstallRecipe,
  stepFor,
  toolchainProcessLine,
  toolchainRuntimeId,
  versionLabel,
} from '../format';
import { useProbeRuntime } from '../hooks/use-runtime-status';
import { useUpdateToolchainMutation } from '../hooks/use-toolchain';
import { useToolIdentities } from '../identity/use-tool-identities';
import { useEnvironmentEntitiesQuery } from '../queries';
import { FindingList } from './FindingList';
import { HealthBadge } from './HealthBadge';
import { InstallationList } from './InstallationList';
import { ProbeButton } from './ProbeButton';
import { RecipeAction } from './RecipeAction';
import { CardSectionLabel, ToolCard } from './ToolCard';
import { ToolchainAction } from './ToolchainAction';

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

  // Only node and bun carry a toolchain pin — `ToolchainSelectionSchema` has
  // no field for fnm, nvm, or winget, so every lookup below reads as "no
  // action here" for those cards rather than guessing at a shape that does
  // not exist on the wire.
  const runtimeId = toolchainRuntimeId(status.id);
  const scopedEnvironmentId = environmentId ?? LOCAL_ENVIRONMENT_ID;
  const environments = useEnvironmentEntitiesQuery();
  const environment = environments.data?.find((candidate) => candidate.id === scopedEnvironmentId);
  const toolchainSelection = runtimeId ? (environment?.toolchain?.[runtimeId] ?? 'auto') : 'auto';
  const toolchain = useUpdateToolchainMutation(scopedEnvironmentId);
  const processLine = runtimeId
    ? toolchainProcessLine(t, resolve, status, toolchainSelection)
    : undefined;

  const selectToolchain = (path: string) => {
    if (runtimeId) toolchain.mutate({ runtimeId, choice: path });
  };
  const resetToolchain = () => {
    if (runtimeId) toolchain.mutate({ runtimeId, choice: 'auto' });
  };

  // Node's update is not one recipe: which chain runs — or whether nothing
  // here can touch it at all — depends on which manager put the effective
  // binary on PATH. Every other runtime updates through a single recipe.
  const nodeAffordance = isNode ? nodeUpdateAffordance(status, recipes) : undefined;
  const updateStep = isNode
    ? nodeAffordance?.kind === 'steps'
      ? nodeAffordance.primary
      : undefined
    : stepFor(findInstallRecipe(recipes, status.id, 'update'));
  const managedElsewhere =
    nodeAffordance?.kind === 'managed-elsewhere'
      ? renderManagedElsewhere(nodeAffordance.source, t, resolve)
      : null;
  const uninstallStep = stepFor(runtimeUninstallRecipe(status, recipes));

  const hasInstalledFooter =
    Boolean(updateStep) || Boolean(managedElsewhere) || Boolean(uninstallStep);
  const installStepValue = installStep(recipes, status.id);

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
          installStepValue ? (
            <RecipeAction
              step={installStepValue}
              action="install"
              catalog={recipes}
              name={name}
              environmentId={environmentId}
            />
          ) : null
        ) : hasInstalledFooter ? (
          <>
            {managedElsewhere}
            <RecipeAction
              step={updateStep}
              action="update"
              catalog={recipes}
              name={name}
              environmentId={environmentId}
              {...(nodeAffordance?.kind === 'steps' && { followUpSteps: nodeAffordance.followUp })}
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
            {runtimeId && (
              <ToolchainAction
                path={effective.path}
                selected={toolchainSelection === effective.path}
                isPending={toolchain.isPending}
                onSelect={selectToolchain}
              />
            )}
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

      {runtimeId && (processLine || toolchainSelection !== 'auto' || toolchain.isError) && (
        <section className="space-y-1.5" data-testid="toolchain-status">
          {processLine && <p className="text-xs text-on-surface-variant/60">{processLine}</p>}
          {toolchainSelection !== 'auto' && (
            <Button
              variant="ghost"
              size="sm"
              loading={toolchain.isPending}
              onClick={resetToolchain}
            >
              {e.runtimes.backToAutomatic}
            </Button>
          )}
          {toolchain.isError && (
            <p className="text-xs text-error" role="alert">
              {resolveApiErrorMessage(toolchain.error, e.runtimes.toolchainUpdateFailed)}
            </p>
          )}
        </section>
      )}

      <FindingList findings={status.findings} />

      {groups.length > 1 && (
        <section className="space-y-2">
          <CardSectionLabel>{e.runtimes.otherInstallations}</CardSectionLabel>
          <InstallationList
            groups={groups.filter((group) => !group.effective)}
            toolchain={
              runtimeId
                ? {
                    selection: toolchainSelection,
                    isPending: toolchain.isPending,
                    onSelect: selectToolchain,
                  }
                : undefined
            }
          />
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

/**
 * Node whose effective binary came from a manager MangoStudio does not drive
 * (Volta, a plain system install): stating that is the honest affordance,
 * since no button here could change it.
 */
function renderManagedElsewhere(
  source: PathSource,
  t: Messages,
  resolve: IdentityResolver
): React.ReactNode {
  // "Managed by {manager}" cannot carry a bare "the system" grammatically in
  // every locale, so a plain system install gets its own full sentence
  // instead of a name plugged into the template.
  const text =
    source === 'system'
      ? t.environments.runtimes.managedBySystem
      : formatMessage(t.environments.runtimes.managedElsewhere, {
          manager: pathSourceManagerName(t, resolve, source),
        });
  return (
    <p className="text-sm text-on-surface-variant/70" data-testid="node-managed-elsewhere">
      {text}
    </p>
  );
}
