/**
 * nvm-managed Node versions with their LTS standing.
 *
 * Colour follows one rule: yellow means an action exists next to it. A
 * superseded LTS is yellow because there is an install button; `current-release`
 * is neutral because choosing a non-LTS release is a decision, not a defect; and
 * `unknown` is neutral because stale offline LTS data is a state, not a failure.
 */

import type {
  InstallRecipePreview,
  LtsStatus,
  VersionManagerStatus,
} from '@mangostudio/shared/environments';
import { ToolAvatar } from '@/components/ui/ToolAvatar';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { displayName, ltsLabel } from '../format';
import { useProbeVersionManager } from '../hooks/use-runtime-status';
import { ToolIdentityMenu } from '../identity/ToolIdentityMenu';
import { useToolIdentities } from '../identity/use-tool-identities';
import { FindingList } from './FindingList';
import { InstallAction } from './InstallAction';
import { ProbeButton } from './ProbeButton';
import { CardSectionLabel } from './ToolCard';

interface NodeVersionTableProps {
  status: VersionManagerStatus;
  recipes: readonly InstallRecipePreview[];
  /** The machine this table is about; a re-check has to go back to the same one. */
  environmentId?: string;
}

const LTS_STYLES: Record<LtsStatus, string> = {
  'current-lts': 'text-primary',
  'lts-outdated-patch': 'text-tertiary',
  'lts-superseded': 'text-tertiary',
  'end-of-life': 'text-error',
  'current-release': 'text-on-surface-variant',
  unknown: 'text-on-surface-variant/60',
};

/** Statuses whose fix is an upgrade, so the row offers one. */
const UPGRADABLE: ReadonlySet<LtsStatus> = new Set<LtsStatus>([
  'lts-outdated-patch',
  'lts-superseded',
  'end-of-life',
]);

export function NodeVersionTable({ status, recipes, environmentId }: NodeVersionTableProps) {
  const { t } = useI18n();
  const e = t.environments;
  const probe = useProbeVersionManager(environmentId);
  const { resolve } = useToolIdentities();
  const defaultManagerName = displayName(t, status.id);
  const identity = resolve('version-manager', status.id, defaultManagerName);
  const manager = identity.name;

  const managerInstallRecipe = recipes.find(
    (recipe) => recipe.runtimeId === status.id && recipe.action === 'install'
  );
  const nodeInstallRecipe = recipes.find((recipe) => recipe.id === 'nvm.node.install');
  const setDefaultRecipe = recipes.find((recipe) => recipe.id === 'nvm.node.set-default');

  if (!status.installed) {
    return (
      <section className="space-y-3" data-testid="node-version-table">
        <p className="text-sm text-on-surface-variant/70">
          {formatMessage(e.versions.managerMissing, { manager })}
        </p>
        <InstallAction
          recipe={managerInstallRecipe}
          input={{ kind: 'none' }}
          label={formatMessage(e.versions.installManager, { manager })}
        />
      </section>
    );
  }

  const offersUpgrade = status.versions.some((version) => UPGRADABLE.has(version.ltsStatus));

  return (
    <section className="space-y-3" data-testid="node-version-table">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <ToolAvatar
            subjectKey={identity.subjectKey}
            monogram={identity.monogram}
            name={manager}
            image={identity.image}
            size="sm"
          />
          <CardSectionLabel className="truncate">
            {formatMessage(e.versions.title, { manager })}
          </CardSectionLabel>
        </div>
        <div className="flex items-center gap-2">
          <ProbeButton
            isPending={probe.isPending}
            isError={probe.isError}
            onProbe={() => probe.mutate(status.id)}
          />
          <ToolIdentityMenu identity={identity} defaultName={defaultManagerName} />
        </div>
      </div>

      <FindingList findings={status.findings} />

      {status.versions.length === 0 ? (
        <p className="text-sm text-on-surface-variant/70">
          {formatMessage(e.versions.empty, { manager })}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {status.versions.map((version) => (
            <li
              key={version.version}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm"
              data-testid="managed-version-row"
              data-version={version.version}
            >
              <span className="font-mono text-on-surface">{version.version}</span>
              {version.isDefault && (
                <span className="text-xs text-on-surface-variant/60">{e.versions.default}</span>
              )}
              {version.isCurrent && (
                <span className="text-xs text-on-surface-variant/60">{e.versions.current}</span>
              )}
              <span
                className={`ml-auto text-xs ${LTS_STYLES[version.ltsStatus]}`}
                data-testid="lts-badge"
                data-lts-status={version.ltsStatus}
              >
                {version.ltsCodename
                  ? `${ltsLabel(t, version.ltsStatus)} · ${version.ltsCodename}`
                  : ltsLabel(t, version.ltsStatus)}
              </span>
              {!version.isDefault && setDefaultRecipe && (
                <InstallAction
                  recipe={setDefaultRecipe}
                  input={{ kind: 'node-version', version: version.version }}
                  label={e.versions.setDefault}
                  variant="ghost"
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {(offersUpgrade || status.versions.length === 0) && (
        <InstallAction
          recipe={nodeInstallRecipe}
          input={{ kind: 'node-version', version: 'lts' }}
          label={e.versions.installLts}
        />
      )}
    </section>
  );
}
