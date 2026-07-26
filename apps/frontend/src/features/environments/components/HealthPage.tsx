/**
 * Health screen: every finding across runtimes, version managers, and agent
 * CLIs as one flat list, worst first — the page to open when something is broken
 * and you do not know where.
 */

import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { describeFinding, displayName, formatMessage } from '../format';
import { useEnvironmentHealth } from '../hooks/use-runtime-status';
import { EnvironmentPageState } from './EnvironmentPageState';
import { FindingIcon } from './FindingList';

export function HealthPage() {
  const { t } = useI18n();
  const e = t.environments;
  const { entries, isPending, error, refetch } = useEnvironmentHealth();

  if (isPending && entries.length === 0) {
    return <EnvironmentPageState variant="loading" />;
  }

  if (error && entries.length === 0) {
    return <EnvironmentPageState variant="error" onRetry={refetch} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-on-surface-variant/60">{e.health.description}</p>
        <Button variant="ghost" size="sm" onClick={refetch}>
          {e.actions.refresh}
        </Button>
      </div>

      {entries.length === 0 ? (
        <EnvironmentPageState variant="empty" title={e.health.empty} hint={e.health.emptyHint} />
      ) : (
        <>
          <p className="text-sm text-on-surface-variant/70">
            {formatMessage(e.health.findingCount, { count: String(entries.length) })}
          </p>
          <ul className="space-y-2" data-testid="health-list">
            {entries.map((entry) => (
              <li
                key={entry.key}
                className="flex items-start gap-3 rounded-2xl border border-outline-variant/15 bg-surface-container-high p-4"
                data-testid="health-entry"
                data-severity={entry.severity}
              >
                <FindingIcon severity={entry.severity} size={18} />
                <div className="min-w-0 space-y-1">
                  <p className="font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/60">
                    {e.health.scope[entry.scope]} · {displayName(t, entry.subjectId)}
                  </p>
                  <p className="text-sm text-on-surface-variant">
                    {describeFinding(t, entry.finding)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
