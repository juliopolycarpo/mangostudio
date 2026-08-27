import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { annotateBranchesWithPrs, type BranchPrAnnotation } from '../lib/branch-pr-annotation';
import { githubPrsQueryOptions } from '../queries';

/**
 * Every recent pull request in the repository, indexed by head branch.
 *
 * Reads the `all` filter, which is the only one that can report `MERGED` — the
 * other three resolve to `--state=open`, so under any of them a merged branch
 * and a branch that never had a pull request are indistinguishable, and
 * "indistinguishable" is exactly the confusion this annotation removes.
 *
 * Bounded by the list's own 30-row cap: this covers *recent* pull requests, not
 * every one the repository has ever had. Older branches go unannotated, which
 * reads the same as having no pull request.
 *
 * @example
 * const annotations = useBranchPrAnnotations(chatId);
 * annotations.get('feat/github-panel')?.isMerged; // true
 */
export function useBranchPrAnnotations(chatId: string): ReadonlyMap<string, BranchPrAnnotation> {
  const query = useQuery(githubPrsQueryOptions(chatId, 'all'));
  const prs = query.data?.state === 'ok' ? query.data.prs : null;

  return useMemo(() => annotateBranchesWithPrs(prs ?? []), [prs]);
}

/**
 * A branch's pull request number and state, beside its name in the branch list.
 *
 * Renders nothing for a branch with no known pull request, which is most of
 * them: an annotation that appeared on every row would be a column, and this is
 * a hint.
 *
 * @example
 * <BranchPrTag annotation={annotations.get(branch.name)} />
 */
export function BranchPrTag({
  annotation,
}: {
  readonly annotation: BranchPrAnnotation | undefined;
}) {
  const { t } = useI18n();
  if (!annotation) return null;

  const number = formatMessage(t.github.row.number, { number: String(annotation.number) });

  return (
    <span
      className={`shrink-0 font-mono text-[10px] ${
        annotation.isMerged ? 'text-success' : 'text-on-surface-variant/70'
      }`}
      title={annotation.isMerged ? t.github.branchPr.merged : annotation.url}
    >
      {annotation.isMerged ? `${number} · ${t.github.branchPr.merged}` : number}
    </span>
  );
}
