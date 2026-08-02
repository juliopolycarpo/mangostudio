/**
 * Health screen: every finding across runtimes, version managers, and agent
 * CLIs as one flat list, worst first — the page to open when something is
 * broken and you do not know where.
 *
 * Findings are per machine, so the list names one. Compare mode is the other
 * question this page can answer: not "what is wrong here" but "what does this
 * machine have that the other one does not".
 */

import { Columns2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { describeFinding } from '../format';
import { useEnvironmentHealth } from '../hooks/use-runtime-status';
import { useToolIdentities } from '../identity/use-tool-identities';
import { useEnvironmentScope } from '../use-environment-scope';
import { CapabilityDiff } from './CapabilityDiff';
import { EnvironmentPageState } from './EnvironmentPageState';
import { EnvironmentScopeHeader } from './EnvironmentScopeHeader';
import { EnvironmentScopeNotice } from './EnvironmentScopeNotice';
import { FindingIcon } from './FindingList';

export function HealthPage() {
  const { t } = useI18n();
  const e = t.environments;
  const scope = useEnvironmentScope();
  const { entries, isPending, error, refetch } = useEnvironmentHealth(
    scope.environmentId,
    // Unknown (still loading) stays enabled so Local is not blocked on the
    // entities fetch; a known disconnected machine must not be woken up.
    scope.permitsProbing && (scope.environment === undefined || scope.isConnected)
  );
  // The health scopes are exactly the static identity kinds, so an entry names
  // its subject the same way that subject's own card does.
  const { resolve, lookup } = useToolIdentities();
  const [comparison, setComparison] = useState<{ left: string; right: string } | null>(null);

  const openComparison = () => {
    const other = scope.environments.find((environment) => environment.id !== scope.environmentId);
    if (!other) return;
    setComparison({ left: scope.environmentId, right: other.id });
  };

  const header = (
    <EnvironmentScopeHeader description={e.health.description} scope={scope} onRefresh={refetch}>
      {scope.hasChoice && !comparison && (
        <Button variant="ghost" size="sm" onClick={openComparison}>
          <Columns2 size={14} />
          {e.scope.compare}
        </Button>
      )}
    </EnvironmentScopeHeader>
  );

  if (comparison) {
    return (
      <div className="space-y-4">
        {header}
        <CapabilityDiff
          environments={scope.environments}
          leftId={comparison.left}
          rightId={comparison.right}
          onSelect={(side, environmentId) =>
            setComparison((current) => (current ? { ...current, [side]: environmentId } : current))
          }
          onClose={() => setComparison(null)}
        />
      </div>
    );
  }

  if (scope.environment && !scope.permitsProbing) {
    return (
      <div className="space-y-4">
        {header}
        <EnvironmentScopeNotice environment={scope.environment} reason="not-permitted" />
      </div>
    );
  }

  if (isPending && entries.length === 0) {
    return (
      <div className="space-y-4">
        {header}
        <EnvironmentPageState variant="loading" />
      </div>
    );
  }

  if (error && entries.length === 0) {
    return (
      <div className="space-y-4">
        {header}
        {scope.environment && !scope.isConnected ? (
          <EnvironmentScopeNotice environment={scope.environment} reason="disconnected" />
        ) : (
          <EnvironmentPageState variant="error" onRetry={refetch} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {header}

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
                    {e.health.scope[entry.scope]} · {resolve(entry.scope, entry.subjectId).name}
                  </p>
                  <p className="text-sm text-on-surface-variant">
                    {describeFinding(t, entry.finding, lookup)}
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
