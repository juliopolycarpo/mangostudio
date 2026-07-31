/**
 * One runtime: which binary actually runs, what is wrong with that, and the fix.
 *
 * The effective installation leads the card because "which node runs" is the
 * question the page exists to answer; the installation list below is evidence,
 * not the headline.
 */

import type { InstallRecipePreview, RuntimeStatus } from '@mangostudio/shared/environments';
import { Download } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { effectiveInstallation, findInstallRecipe, pathPosition } from '../format';
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
  children?: React.ReactNode;
}

export function RuntimeCard({ status, recipes, children }: RuntimeCardProps) {
  const { t } = useI18n();
  const e = t.environments;
  const probe = useProbeRuntime();
  const { resolve } = useToolIdentities();
  const name = resolve('runtime', status.id).name;

  const { groups, group: effectiveGroup, installation: effective } = effectiveInstallation(status);

  const installRecipe = findInstallRecipe(recipes, status.id, 'install');
  const updateRecipe = findInstallRecipe(recipes, status.id, 'update');

  return (
    <ToolCard
      kind="runtime"
      id={status.id}
      testId="runtime-card"
      dataAttributes={{ 'data-runtime-id': status.id }}
      subtitle={
        // Nothing installed is not "0 versions": the body already says so.
        groups.length > 0 ? (
          <p className="text-xs text-on-surface-variant/60">
            {groups.length === 1
              ? e.runtimes.singleVersion
              : formatMessage(e.runtimes.versionCount, { count: String(groups.length) })}
          </p>
        ) : undefined
      }
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
      footer={
        <>
          {status.installations.length === 0 && installRecipe && (
            <InstallAction
              recipe={installRecipe}
              input={{ kind: 'none' }}
              label={formatMessage(e.runtimes.install, { runtime: name })}
              variant="primary"
              icon={<Download size={14} />}
            />
          )}
          {status.installations.length > 0 && updateRecipe && (
            <InstallAction
              recipe={updateRecipe}
              input={{ kind: 'none' }}
              label={formatMessage(e.runtimes.update, { runtime: name })}
            />
          )}
        </>
      }
    >
      {effective ? (
        <section className="space-y-1" data-testid="effective-installation">
          <CardSectionLabel>{e.runtimes.effectiveLabel}</CardSectionLabel>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-base font-semibold text-on-surface">
              {effective.version}
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
              effective.managedBy
                ? formatMessage(e.runtimes.managedByLabel, {
                    manager: resolve('version-manager', effective.managedBy).name,
                  })
                : null,
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
