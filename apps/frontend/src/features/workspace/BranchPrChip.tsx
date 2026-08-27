import type { GithubContext } from '@mangostudio/shared/github';
import { useQuery } from '@tanstack/react-query';
import { GitPullRequest } from 'lucide-react';
import { StatusDot } from '@/components/ui/StatusDot';
import { GithubPrBadge } from '@/features/github/components/GithubPrBadge';
import { checkChipStatus } from '@/features/github/lib/check-status';
import { githubPrChecksQueryOptions } from '@/features/github/queries';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_SM } from '@/lib/icon-sizes';
import { requestRailPanel } from './rail/rail-panel-request';

interface BranchPrChipProps {
  readonly chatId: string;
  readonly context: GithubContext | undefined;
}

/**
 * One line in the Repository panel: this branch's pull request, and whether CI
 * is happy with it.
 *
 * What used to sit here was a second, smaller GitHub panel — repository name,
 * default branch, install and auth hints, its own error and loading states.
 * All of that now has a panel of its own, so keeping a copy in the Git panel
 * meant two surfaces answering the same question and drifting apart. This is
 * the one fact the Git panel still needs: you are on a branch, it has a pull
 * request, here is its state. Everything else is one click away.
 *
 * Renders nothing at all when there is no pull request to name — an empty
 * "GitHub" heading in a panel about the working tree is pure furniture.
 *
 * @example
 * <BranchPrChip chatId={chatId} context={githubQuery.data} />
 */
export function BranchPrChip({ chatId, context }: BranchPrChipProps) {
  const { t } = useI18n();
  const pr = context?.state === 'ok' ? context.pr : null;
  // Shares the panel's cache entry, so opening the GitHub panel afterwards
  // costs no second `gh pr checks` for the pull request already on screen.
  const checksQuery = useQuery({
    ...githubPrChecksQueryOptions(chatId, pr?.number ?? 0),
    enabled: pr !== null,
  });

  if (!pr) return null;

  const summary = checksQuery.data?.state === 'ok' ? checksQuery.data.summary : null;
  const checks = checkChipStatus(summary);

  return (
    <button
      type="button"
      onClick={() => requestRailPanel('github')}
      title={t.github.panel.open}
      className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-xl border border-outline-variant/15 bg-surface-container/35 px-3 py-2 text-left transition-colors hover:border-primary/30 focus-visible:outline-2 focus-visible:outline-primary"
    >
      <GitPullRequest size={ICON_SM} className="shrink-0 text-primary" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-xs text-on-surface">
        {formatMessage(t.github.panel.branchChip, {
          number: String(pr.number),
          status: t.github.chip[checks.labelKey],
        })}
      </span>
      <StatusDot tone={checks.tone} />
      <GithubPrBadge state={pr.state} draft={pr.isDraft} />
    </button>
  );
}
