/**
 * The duplicates table: one row per distinct binary, effective one first.
 *
 * A symlink chain is one row with a "reachable via N paths" affordance — the
 * detection layer already separates an alias from a real duplicate, and showing
 * both as separate rows would undo that.
 */

import type { ToolchainChoice } from '@mangostudio/shared/environments';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { type InstallationGroup, pathPosition, versionLabel } from '../format';
import { useToolIdentities } from '../identity/use-tool-identities';
import { ToolchainAction } from './ToolchainAction';

/** Present only for the node/bun cards, which can pin one of these rows. */
interface InstallationListToolchain {
  readonly selection: ToolchainChoice;
  readonly isPending: boolean;
  readonly onSelect: (path: string) => void;
}

interface InstallationListProps {
  /**
   * Already-grouped installations. The caller owns the grouping so a card that
   * needs the effective group for its header does not pay for it twice.
   */
  groups: readonly InstallationGroup[];
  toolchain?: InstallationListToolchain;
}

export function InstallationList({ groups, toolchain }: InstallationListProps) {
  const { t } = useI18n();
  const e = t.environments;
  const { resolve } = useToolIdentities();

  if (groups.length === 0) return null;

  return (
    <ul className="space-y-1.5" data-testid="installation-list">
      {groups.map((group) => {
        const { canonical, aliasCount } = group;
        return (
          <li
            key={canonical.path}
            className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm"
            data-testid="installation-row"
          >
            <span className="font-mono text-on-surface">{versionLabel(t, canonical.version)}</span>
            <span className="min-w-0 break-all font-mono text-xs text-on-surface-variant/70">
              {canonical.rawPath}
            </span>
            {canonical.pathIndex !== undefined && (
              <span className="text-xs text-on-surface-variant/60">
                {formatMessage(e.runtimes.pathIndexLabel, {
                  position: String(pathPosition(canonical.pathIndex)),
                })}
              </span>
            )}
            {canonical.managedBy && (
              <span className="text-xs text-on-surface-variant/60">
                {formatMessage(e.runtimes.managedByLabel, {
                  manager: resolve('version-manager', canonical.managedBy).name,
                })}
              </span>
            )}
            {aliasCount > 1 && (
              <span className="text-xs text-on-surface-variant/60" data-testid="alias-affordance">
                {formatMessage(e.runtimes.aliasReachable, { count: String(aliasCount) })}
              </span>
            )}
            {toolchain && (
              <ToolchainAction
                path={canonical.path}
                selected={toolchain.selection === canonical.path}
                isPending={toolchain.isPending}
                onSelect={toolchain.onSelect}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
