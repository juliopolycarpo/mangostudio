/**
 * Health screen: every finding across runtimes, version managers, and agent
 * CLIs, split by whether anything has to be done — what needs action first, what
 * can wait after it — the page to open when something is broken and you do not
 * know where. Each row opens the tab that can fix it.
 *
 * Findings are per machine, so the list names one. Compare mode is the other
 * question this page can answer: not "what is wrong here" but "what does this
 * machine have that the other one does not".
 */

import { Link } from '@tanstack/react-router';
import { ChevronRight, Columns2 } from 'lucide-react';
import { useId, useState } from 'react';
import { Button, buttonClassName } from '@/components/ui/Button';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';
import { describeFinding } from '../format';
import {
  type HealthEntry,
  type HealthScope,
  useEnvironmentHealth,
} from '../hooks/use-runtime-status';
import { useToolIdentities } from '../identity/use-tool-identities';
import { environmentScopeSearch, useEnvironmentScope } from '../use-environment-scope';
import { CapabilityDiff } from './CapabilityDiff';
import { EnvironmentPageState } from './EnvironmentPageState';
import { EnvironmentScopeHeader } from './EnvironmentScopeHeader';
import { EnvironmentScopeNotice } from './EnvironmentScopeNotice';
import { FindingIcon } from './FindingList';
import { TOOL_CARD_SURFACE } from './ToolCard';

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
  const [comparison, setComparison] = useState<{ left: string; right: string } | null>(null);

  const openComparison = () => {
    const other = scope.environments.find((environment) => environment.id !== scope.environmentId);
    if (!other) return;
    setComparison({ left: scope.environmentId, right: other.id });
  };

  const header = (
    <EnvironmentScopeHeader description={e.health.description} scope={scope} onRefresh={refetch}>
      {scope.hasChoice && !comparison && (
        <Button variant="subtle" size="sm" onClick={openComparison}>
          <Columns2 size={ICON_MD} />
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
        <div className="space-y-6">
          <HealthGroup
            label={e.health.needsAction}
            entries={entries.filter((entry) => entry.severity === 'fail')}
            environmentId={scope.environmentId}
          />
          <HealthGroup
            label={e.health.canWait}
            entries={entries.filter((entry) => entry.severity === 'warn')}
            environmentId={scope.environmentId}
          />
        </div>
      )}
    </div>
  );
}

/** The tab that can act on a finding: the card for that tool lives there. */
const FIX_TAB = {
  runtime: { to: '/environments/runtimes', tab: 'runtimes' },
  'version-manager': { to: '/environments/runtimes', tab: 'runtimes' },
  agent: { to: '/environments/agents', tab: 'agents' },
} as const satisfies Record<HealthScope, { to: string; tab: 'runtimes' | 'agents' }>;

/** One severity's findings under its heading; nothing at all when it has none. */
function HealthGroup({
  label,
  entries,
  environmentId,
}: {
  readonly label: string;
  readonly entries: readonly HealthEntry[];
  readonly environmentId: string;
}) {
  const { t } = useI18n();
  const e = t.environments;
  // The health scopes are exactly the static identity kinds, so an entry names
  // its subject the same way that subject's own card does.
  const { resolve, lookup } = useToolIdentities();
  const headingId = useId();

  if (entries.length === 0) return null;

  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <MicroLabel as="h2" id={headingId}>
        {label}
      </MicroLabel>
      <ul className={cn(TOOL_CARD_SURFACE, 'divide-y divide-stroke')} data-testid="health-list">
        {entries.map((entry) => {
          const fix = FIX_TAB[entry.scope];
          return (
            <li
              key={entry.key}
              className="flex items-start gap-3 p-4"
              data-testid="health-entry"
              data-severity={entry.severity}
            >
              <FindingIcon severity={entry.severity} quiet={entry.quiet} size={ICON_MD} />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-sm font-medium text-fg">
                  {e.health.scope[entry.scope]} · {resolve(entry.scope, entry.subjectId).name}
                </p>
                <p className="text-sm text-fg-muted">{describeFinding(t, entry.finding, lookup)}</p>
              </div>
              <Link
                to={fix.to}
                search={environmentScopeSearch(environmentId)}
                className={cn(buttonClassName('subtle', 'sm'), 'shrink-0')}
                data-testid="health-entry-link"
              >
                {e.overview.open[fix.tab]}
                <ChevronRight size={ICON_SM} aria-hidden="true" />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
