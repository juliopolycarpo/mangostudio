/**
 * The coverage matrix collapsed to one line per target.
 *
 * Reads the same resource and target queries the matrix does — the overview
 * adds no endpoint of its own — and reports only what those already answer:
 * how much each agent reads, and how much of it disagrees with everyone else.
 * Divergence leads because it is the number that costs somebody an afternoon.
 */

import { useQueries } from '@tanstack/react-query';
import { ToolAvatar } from '@/components/ui/ToolAvatar';
import { summarizeCoverageByTarget } from '@/features/library/format';
import {
  libraryResourcesQueryOptions,
  libraryTargetsQueryOptions,
} from '@/features/library/queries';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { useToolIdentities } from '../identity/use-tool-identities';
import { EnvironmentPageState } from './EnvironmentPageState';
import { OverviewSection } from './OverviewSection';
import { TOOL_CARD_SURFACE } from './ToolCard';

export function OverviewLibrarySnapshot() {
  const { t } = useI18n();
  const e = t.environments;
  const { resolve } = useToolIdentities();

  const [resources, targets] = useQueries({
    queries: [libraryResourcesQueryOptions(), libraryTargetsQueryOptions()],
  });

  const hasData = resources.data !== undefined && targets.data !== undefined;
  const summaries = summarizeCoverageByTarget(
    resources.data ?? [],
    (targets.data ?? []).map((target) => target.id)
  );

  return (
    <OverviewSection
      title={e.tabs.library}
      to="/environments/library"
      testId="overview-library"
      isPending={(resources.isPending || targets.isPending) && !hasData}
      hasError={Boolean(resources.error ?? targets.error) && !hasData}
      onRetry={() => {
        void resources.refetch();
        void targets.refetch();
      }}
    >
      {summaries.length === 0 ? (
        <EnvironmentPageState variant="empty" size="section" title={e.overview.libraryEmpty} />
      ) : (
        <ul className={`${TOOL_CARD_SURFACE} divide-y divide-outline-variant/10`}>
          {summaries.map((summary) => {
            const identity = resolve(
              'agent',
              summary.targetId,
              t.library.targets[summary.targetId]
            );
            return (
              <li
                key={summary.targetId}
                className="flex items-center gap-3 p-3"
                data-testid="library-coverage-row"
                data-target-id={summary.targetId}
              >
                <ToolAvatar
                  subjectKey={identity.subjectKey}
                  monogram={identity.monogram}
                  name={identity.name}
                  image={identity.image}
                  size="sm"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-on-surface">
                  {identity.name}
                </span>
                {summary.present === 0 ? (
                  <span className="text-xs text-on-surface-variant/60">
                    {e.overview.libraryNone}
                  </span>
                ) : (
                  <span className="flex items-baseline gap-2 text-xs">
                    {summary.divergent > 0 && (
                      <span className="text-tertiary" data-testid="library-divergent-count">
                        {formatMessage(e.overview.libraryDivergent, {
                          count: String(summary.divergent),
                        })}
                      </span>
                    )}
                    <span className="text-on-surface-variant/60">
                      {formatMessage(e.overview.libraryPresent, {
                        count: String(summary.present),
                      })}
                    </span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </OverviewSection>
  );
}
