/**
 * Machines that need attention before the next turn goes anywhere.
 *
 * Silent by default — see `lib/environment-health.ts` for what earns a line
 * and, more importantly, what does not. Reads the environment list the runner
 * selector already holds, so it costs no request and never triggers a probe.
 */

import { Link } from '@tanstack/react-router';
import { SectionCard } from '@/components/ui/SectionCard';
import { StatusDot } from '@/components/ui/StatusDot';
import { useEnvironmentEntitiesQuery } from '@/features/environments/queries';
import { environmentScopeRoute } from '@/features/environments/use-environment-scope';
import { useI18n } from '@/hooks/use-i18n';
import { environmentAlerts } from '../lib/environment-health';

interface EnvironmentHealthCardProps {
  /** The chat's machine — the only one whose being offline is worth a warning. */
  activeEnvironmentId: string | null;
}

export function EnvironmentHealthCard({ activeEnvironmentId }: EnvironmentHealthCardProps) {
  const { t } = useI18n();
  const labels = t.home.environments;
  const environments = useEnvironmentEntitiesQuery().data ?? [];
  const alerts = environmentAlerts(environments, activeEnvironmentId);

  if (alerts.length === 0) return null;

  return (
    <SectionCard
      label={labels.label}
      tone={alerts.some((alert) => alert.severity === 'error') ? 'error' : 'warning'}
    >
      <ul className="space-y-1.5">
        {alerts.map((alert) => (
          <li key={alert.environmentId} className="flex min-w-0 items-center gap-2 text-xs">
            <StatusDot tone={alert.severity === 'error' ? 'error' : 'warning'} />
            <span className="truncate text-on-surface">{alert.name}</span>
            <span className="shrink-0 font-mono text-on-surface-variant/70">
              {alert.severity === 'error' ? labels.failed : labels.disconnected}
            </span>
          </li>
        ))}
      </ul>
      <Link
        {...environmentScopeRoute(alerts[0].environmentId)}
        className="micro-label w-fit text-primary/80 transition-colors hover:text-primary"
      >
        {labels.open}
      </Link>
    </SectionCard>
  );
}
