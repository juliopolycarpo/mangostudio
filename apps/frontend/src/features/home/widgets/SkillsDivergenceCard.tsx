/**
 * The one library fact worth interrupting a new chat for: two harnesses are
 * reading different versions of the same skill, so whichever one answers next
 * behaves differently for reasons nothing on screen explains.
 *
 * Coverage gaps get a footnote, not a headline, and their way out is the
 * library rather than a propagate button — see `lib/skills-divergence.ts` for
 * why. Propagation itself always goes through the library's confirm step; the
 * hub never writes to anyone's machine on one click.
 */

import type { LibraryTargetId } from '@mangostudio/shared/library';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { SectionCard } from '@/components/ui/SectionCard';
import { libraryEnvironmentSearch, libraryResourcesQueryOptions } from '@/features/library/queries';
import { useI18n } from '@/hooks/use-i18n';
import { formatList, formatMessage } from '@/lib/i18n-format';
import { type DivergentSkill, summarizeSkillsDivergence } from '../lib/skills-divergence';

interface SkillsDivergenceCardProps {
  environmentId: string | null;
}

export function SkillsDivergenceCard({ environmentId }: SkillsDivergenceCardProps) {
  const { t, locale } = useI18n();
  const labels = t.home.skills;
  const scope = environmentId ?? undefined;
  // A failed or still-loading scan renders nothing at all. This card is the
  // hub's only optional one: it has no resting state worth a skeleton, and a
  // placeholder that resolves to "nothing to report" is pure layout churn.
  const { data } = useQuery(libraryResourcesQueryOptions('skill', scope));
  if (!data) return null;

  const summary = summarizeSkillsDivergence(data.resources);
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
      className="sm:col-span-2"
    >
      {summary.headline ? (
        <DivergenceBody skill={summary.headline} locale={locale} search={search} />
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
            to="/environments/library/skills"
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

function DivergenceBody({
  skill,
  locale,
  search,
}: {
  skill: DivergentSkill;
  locale: string;
  search: { environmentId?: string };
}) {
  const { t } = useI18n();
  const labels = t.home.skills;
  // The library's own target names, so the card and the matrix it links into
  // call the same harness the same thing.
  const targetName = (targetId: LibraryTargetId) => t.library.targets[targetId];

  // With no agreeing side there is no "different from what" to name — two
  // copies, two versions, neither the norm. The matrix says the same thing by
  // marking both cells divergent.
  const body =
    skill.agreeing.length === 0
      ? formatMessage(labels.divergenceBodyNoMajority, {
          targets: formatList(skill.outliers.map(targetName), locale),
        })
      : formatMessage(labels.divergenceBody, {
          outliers: formatList(skill.outliers.map(targetName), locale),
          agreeing: formatList(skill.agreeing.map(targetName), locale),
        });

  return (
    <div className="space-y-2.5">
      <p className="terminal-chip h-6 w-fit max-w-full text-on-surface">
        <span className="truncate">{skill.slug}</span>
      </p>
      <p className="text-sm leading-relaxed text-on-surface-variant">{body}</p>
      <div className="flex flex-wrap gap-2">
        {/* Both land on the resource page: propagation runs there, behind its
            own preview-and-confirm step. */}
        <Link
          to="/environments/library/$resourceKey"
          params={{ resourceKey: skill.key }}
          search={search}
          className="inline-flex items-center rounded-lg border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-bold text-primary transition-colors hover:bg-primary/20"
        >
          {labels.propagate}
        </Link>
        <Link
          to="/environments/library/$resourceKey"
          params={{ resourceKey: skill.key }}
          search={{ ...search, compare: true }}
          className="inline-flex items-center rounded-lg border border-outline-variant/25 px-3 py-1.5 text-xs font-bold text-on-surface-variant transition-colors hover:border-outline-variant/50 hover:text-on-surface"
        >
          {labels.viewDiff}
        </Link>
      </div>
    </div>
  );
}
