/**
 * Machines that need attention before the next turn goes anywhere.
 *
 * Silent by default — see `lib/environment-health.ts` for what earns a line
 * and, more importantly, what does not. Reads the environment list the runner
 * selector already holds, so it costs no request and never triggers a probe.
 */

import type { Environment } from '@mangostudio/shared/environments';
import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { SectionCard } from '@/components/ui/SectionCard';
import { StatusDot } from '@/components/ui/StatusDot';
import { useEnvironmentEntitiesQuery } from '@/features/environments/queries';
import { environmentScopeRoute } from '@/features/environments/use-environment-scope';
import { useI18n } from '@/hooks/use-i18n';
import { environmentAlerts } from '../lib/environment-health';
import { CARD_LINK_CLASS } from './card-link';

const NO_ENVIRONMENTS: readonly Environment[] = [];

interface EnvironmentHealthCardProps {
  /** The chat's machine — the only one whose being offline is worth a warning. */
  activeEnvironmentId: string | null;
}

export function EnvironmentHealthCard({ activeEnvironmentId }: EnvironmentHealthCardProps) {
  const { t } = useI18n();
  const labels = t.home.environments;
  const environments = useEnvironmentEntitiesQuery().data ?? NO_ENVIRONMENTS;
  // Filters and sorts the whole environment list; the status pushes that change
  // it arrive over a socket, not on every render of the hub around it.
  const alerts = useMemo(
    () => environmentAlerts(environments, activeEnvironmentId),
    [environments, activeEnvironmentId]
  );

  if (alerts.length === 0) return null;

  return (
    <SectionCard
      label={labels.label}
      tone={alerts.some((alert) => alert.severity === 'error') ? 'error' : 'warning'}
    >
      <ul className="space-y-2">
        {alerts.map((alert) => (
          <li key={alert.environmentId} className="flex min-w-0 items-center gap-2 text-sm">
            <StatusDot tone={alert.severity === 'error' ? 'error' : 'warning'} />
            <span className="min-w-0 flex-1 truncate text-fg">{alert.name}</span>
            <span className="shrink-0 text-xs text-fg-muted">
              {alert.severity === 'error' ? labels.failed : labels.disconnected}
            </span>
          </li>
        ))}
      </ul>
      <Link {...environmentScopeRoute(alerts[0].environmentId)} className={CARD_LINK_CLASS}>
        {labels.open}
      </Link>
    </SectionCard>
  );
}
