/**
 * The one library fact worth interrupting for: two harnesses are reading
 * different versions of the same resource, so whichever one answers next
 * behaves differently for reasons nothing on screen explains.
 *
 * Coverage gaps get a footnote, not a headline, and their way out is the
 * library rather than a propagate button — see `lib/library-divergence.ts` for
 * why. Propagation itself always goes through the library's confirm step; the
 * hub never writes to anyone's machine on one click.
 *
 * `kind` is the only scoping seam. The chat hub scans skills, because that is
 * the kind a session is about to be answered with; the dashboard leaves it off
 * and scans everything, because a divergent subagent or instruction file is the
 * same contradiction and there is no session narrowing it down.
 */

import type { Messages } from '@mangostudio/shared/i18n';
import type { LibraryTargetId, ResourceKind } from '@mangostudio/shared/library';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { SectionCard } from '@/components/ui/SectionCard';
import { libraryEnvironmentSearch, libraryResourcesQueryOptions } from '@/features/library/queries';
import { useI18n } from '@/hooks/use-i18n';
import { formatList, formatMessage } from '@/lib/i18n-format';
import { type DivergentResource, summarizeLibraryDivergence } from '../lib/library-divergence';

interface LibraryDivergenceCardProps {
  environmentId: string | null;
  /** Narrows the scan to one kind. Omit to scan every kind in the library. */
  kind?: ResourceKind;
  className?: string;
}

export function LibraryDivergenceCard({
  environmentId,
  kind,
  className,
}: LibraryDivergenceCardProps) {
  const { t, locale } = useI18n();
  const labels = cardLabels(t, kind);
  const scope = environmentId ?? undefined;
  // A failed or still-loading scan renders nothing at all. This card is the
  // hub's only optional one: it has no resting state worth a skeleton, and a
  // placeholder that resolves to "nothing to report" is pure layout churn.
  const { data } = useQuery(libraryResourcesQueryOptions(kind, scope));
  // Two passes over every resource in the library, plus a sort and a
  // per-resource description — none of which changes until the scan itself does.
  const summary = useMemo(() => (data ? summarizeLibraryDivergence(data.resources) : null), [data]);

  if (!summary) return null;
  if (!summary.headline && summary.singleTargetCount === 0) return null;

  const search = libraryEnvironmentSearch(scope);

  return (
    <SectionCard
      label={
        summary.divergentCount > 0
          ? formatMessage(labels.labelDivergent, { count: String(summary.divergentCount) })
          : labels.label
      }
      tone={summary.divergentCount > 0 ? 'warning' : 'neutral'}
      className={className}
    >
      {summary.headline ? (
        <DivergenceBody
          resource={summary.headline}
          labels={labels}
          // Named only on an all-kinds scan: a card that already says "Skills"
          // in its heading would be repeating itself.
          showKind={kind === undefined}
          locale={locale}
          search={search}
        />
      ) : null}

      {summary.divergentCount > 1 ? (
        <p className="text-xs text-on-surface-variant/70">
          {formatMessage(labels.more, { count: String(summary.divergentCount - 1) })}
        </p>
      ) : null}

      {summary.singleTargetCount > 0 ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-outline-variant/10 pt-3 text-xs text-on-surface-variant/70">
          {formatMessage(labels.singleTarget, { count: String(summary.singleTargetCount) })}
          <Link
            to={kind === 'skill' ? '/environments/library/skills' : '/environments/library'}
            search={search}
            className="text-primary/80 transition-colors hover:text-primary"
          >
            {labels.openLibrary}
          </Link>
        </p>
      ) : null}
    </SectionCard>
  );
}

type CardLabels = Messages['home']['skills'];

/**
 * Skill-scoped copy names skills; every other scope gets the kind-neutral set.
 *
 * Two label groups rather than one interpolated noun: "1 skill lives in a
 * single agent" and "1 item lives in a single agent" are different sentences in
 * more languages than English, and a locale cannot fix a sentence it was handed
 * a noun to slot into.
 */
function cardLabels(t: Messages, kind: ResourceKind | undefined): CardLabels {
  return kind === 'skill' ? t.home.skills : t.home.library;
}

function DivergenceBody({
  resource,
  labels,
  showKind,
  locale,
  search,
}: {
  resource: DivergentResource;
  labels: CardLabels;
  showKind: boolean;
  locale: string;
  search: { environmentId?: string };
}) {
  const { t } = useI18n();
  // The library's own target names, so the card and the matrix it links into
  // call the same harness the same thing.
  const targetName = (targetId: LibraryTargetId) => t.library.targets[targetId];

  // With no agreeing side there is no "different from what" to name — two
  // copies, two versions, neither the norm. The matrix says the same thing by
  // marking both cells divergent.
  const body =
    resource.agreeing.length === 0
      ? formatMessage(labels.divergenceBodyNoMajority, {
          targets: formatList(resource.outliers.map(targetName), locale),
        })
      : formatMessage(labels.divergenceBody, {
          outliers: formatList(resource.outliers.map(targetName), locale),
          agreeing: formatList(resource.agreeing.map(targetName), locale),
        });

  return (
    <div className="space-y-2.5">
      <p className="flex flex-wrap items-center gap-1.5">
        <span className="terminal-chip h-6 max-w-full text-on-surface">
          <span className="truncate">{resource.slug}</span>
        </span>
        {showKind ? (
          <span className="micro-label text-on-surface-variant/60">
            {t.library.kinds[resource.kind]}
          </span>
        ) : null}
      </p>
      <p className="text-sm leading-relaxed text-on-surface-variant">{body}</p>
      <div className="flex flex-wrap gap-2">
        {/* Both land on the resource page: propagation runs there, behind its
            own preview-and-confirm step. */}
        <Link
          to="/environments/library/$resourceKey"
          params={{ resourceKey: resource.key }}
          search={search}
          className="inline-flex items-center rounded-lg border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-bold text-primary transition-colors hover:bg-primary/20"
        >
          {labels.propagate}
        </Link>
        <Link
          to="/environments/library/$resourceKey"
          params={{ resourceKey: resource.key }}
          search={{ ...search, compare: true }}
          className="inline-flex items-center rounded-lg border border-outline-variant/25 px-3 py-1.5 text-xs font-bold text-on-surface-variant transition-colors hover:border-outline-variant/50 hover:text-on-surface"
        >
          {labels.viewDiff}
        </Link>
      </div>
    </div>
  );
}
