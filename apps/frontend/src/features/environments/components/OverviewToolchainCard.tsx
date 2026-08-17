/**
 * One toolchain, compact: which version actually runs and whether that is fine.
 *
 * The version shown is the effective one — the binary a shell would reach —
 * never the newest installed, because the strip exists to answer "what runs"
 * and the Toolchains tab is where the other installations are accounted for.
 */

import type { RuntimeStatus } from '@mangostudio/shared/environments';
import { useI18n } from '@/hooks/use-i18n';
import { effectiveInstallation } from '../format';
import { HealthBadge } from './HealthBadge';
import { ToolCard } from './ToolCard';

export function OverviewToolchainCard({ status }: { readonly status: RuntimeStatus }) {
  const { t } = useI18n();
  const e = t.environments;
  const { installation } = effectiveInstallation(status);

  return (
    <ToolCard
      kind="runtime"
      id={status.id}
      avatarSize="sm"
      density="compact"
      testId="overview-toolchain-card"
      dataAttributes={{ 'data-runtime-id': status.id }}
      subtitle={
        <p className="truncate font-mono text-xs text-on-surface-variant/70">
          {installation
            ? (installation.version ?? e.runtimes.versionUnknown)
            : e.agents.notInstalled}
        </p>
      }
      actions={<HealthBadge health={status.health} />}
    />
  );
}
