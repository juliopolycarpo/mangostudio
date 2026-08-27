import type { GithubCheckBucket } from '@mangostudio/shared/github';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, MessageSquareQuote, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { StatusDot, type StatusDotTone } from '@/components/ui/StatusDot';
import { useToast } from '@/components/ui/Toast';
import {
  getComposerDraft,
  requestComposerFocus,
  setComposerDraft,
} from '@/features/chat/lib/composer-draft-store';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_LG, ICON_SM } from '@/lib/icon-sizes';
import { resolveApiErrorMessage } from '@/lib/utils';
import { markPullRequestReady } from '../api';
import { reviewThreadsToTask } from '../lib/review-thread-task';
import {
  githubKeys,
  githubPrChecksQueryOptions,
  githubPrDetailQueryOptions,
  githubPrThreadsQueryOptions,
} from '../queries';
import { GithubNotConnected } from './GithubNotConnected';

interface GithubPrDetailProps {
  readonly chatId: string;
  readonly number: number;
  readonly onBack: () => void;
}

/** The rail's testid for the per-pull-request view. */
const GITHUB_PR_DETAIL_TESTID = 'github-pr-detail';

/**
 * One pull request: what it changes, whether CI likes it, and what reviewers
 * are still waiting on.
 *
 * Three queries rather than one, because they answer at different speeds —
 * `gh pr view` is a single API call, `gh pr checks` waits on the rollup, and
 * the review threads run a GraphQL document. Merging them would make the panel
 * as slow as its slowest part, and the thing somebody came for (the review
 * comments) is behind the slowest of the three.
 *
 * @example
 * <GithubPrDetail chatId={chatId} number={942} onBack={clearSelection} />
 */
export function GithubPrDetail({ chatId, number, onBack }: GithubPrDetailProps) {
  const { t } = useI18n();

  return (
    <div data-testid={GITHUB_PR_DETAIL_TESTID} className="space-y-2">
      <button
        type="button"
        onClick={onBack}
        className="flex cursor-pointer items-center gap-1 text-[10px] font-semibold text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary"
      >
        <ArrowLeft size={12} aria-hidden="true" />
        {t.github.panel.back}
      </button>
      <DetailBody chatId={chatId} number={number} />
    </div>
  );
}

/**
 * Split from the shell so the four-way degradation is a run of early returns
 * rather than nested ternaries inside JSX. The query is re-read rather than
 * passed down — React Query serves both calls from one cache entry.
 */
function DetailBody({ chatId, number }: { readonly chatId: string; readonly number: number }) {
  const { t } = useI18n();
  const query = useQuery(githubPrDetailQueryOptions(chatId, number));

  if (query.isPending) {
    return (
      <EmptyState
        icon={<RefreshCw size={ICON_LG} className="animate-spin" />}
        title={t.github.loading}
        className="min-h-24 py-4"
      />
    );
  }
  if (query.isError || !query.data) {
    return <EmptyState title={t.github.errors.prs} tone="error" className="min-h-24 py-4" />;
  }
  if (query.data.state !== 'ok') return <GithubNotConnected state={query.data.state} />;

  const { pr } = query.data;

  return (
    <div className="space-y-3">
      <div>
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-semibold leading-4 text-on-surface hover:text-primary"
        >
          {formatMessage(t.github.row.number, { number: String(pr.number) })} {pr.title}
        </a>
        <p className="mt-1 text-[10px] text-on-surface-variant">
          {formatMessage(t.github.row.diffStat, {
            additions: String(pr.additions),
            deletions: String(pr.deletions),
            files: String(pr.changedFiles),
          })}
        </p>
        <p className="mt-0.5 text-[10px] text-on-surface-variant">
          {t.github.mergeState[pr.mergeStateStatus]} · {t.github.mergeable[pr.mergeable]}
        </p>
        <p className="mt-0.5 text-[10px] text-on-surface-variant">
          {pr.reviewDecision
            ? t.github.reviewDecision[pr.reviewDecision]
            : t.github.reviewDecisionNone}
        </p>
      </div>

      <MarkReadyAction chatId={chatId} number={number} isDraft={pr.isDraft} />
      <ChecksBlock chatId={chatId} number={number} />
      <ReviewThreadsAction chatId={chatId} number={number} />
    </div>
  );
}

function MarkReadyAction({
  chatId,
  number,
  isDraft,
}: {
  readonly chatId: string;
  readonly number: number;
  readonly isDraft: boolean;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => markPullRequestReady({ chatId, number }),
    onSuccess: async (result) => {
      // A write can still come back not-connected: the user may have lost
      // GitHub between opening the panel and pressing the button.
      if (result.state !== 'ok') {
        toast(t.github.connection[result.state], 'error');
        return;
      }
      await queryClient.invalidateQueries({ queryKey: githubKeys.all });
    },
    onError: (error) => toast(resolveApiErrorMessage(error, t.github.errors.action), 'error'),
  });

  if (!isDraft) return null;

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
      className="w-full"
    >
      <CheckCircle2 size={ICON_SM} />
      {t.github.actions.markReady}
    </Button>
  );
}

/**
 * A failed sub-query of the detail view, with the retry it needs.
 *
 * The rail's header refresh button refetches the *list* query behind whichever
 * tab is open, not the three this view runs, so a checks or threads read that
 * failed on its own has no other way back. One line rather than an `EmptyState`
 * because it sits between two blocks that are already rendering.
 *
 * @example
 * <DetailQueryError label={t.github.errors.checks} onRetry={query.refetch} />
 */
function DetailQueryError({
  label,
  onRetry,
}: {
  readonly label: string;
  readonly onRetry: () => Promise<unknown>;
}) {
  const { t } = useI18n();

  return (
    <p className="text-[10px] text-error">
      {label}{' '}
      <button
        type="button"
        onClick={() => void onRetry()}
        className="cursor-pointer font-semibold underline hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary"
      >
        {t.common.retry}
      </button>
    </p>
  );
}

/** gh's five buckets, painted the way the rest of the panel paints state. */
const CHECK_TONES: Readonly<Record<GithubCheckBucket, StatusDotTone>> = {
  pass: 'success',
  fail: 'error',
  pending: 'warning',
  skipping: 'neutral',
  cancel: 'neutral',
};

function ChecksBlock({ chatId, number }: { readonly chatId: string; readonly number: number }) {
  const { t } = useI18n();
  const query = useQuery(githubPrChecksQueryOptions(chatId, number));

  // A failed read is not a lost connection, and only the second one is already
  // explained above. `gh pr checks` answers separately from `gh pr view`, so it
  // can rate-limit, lose authorization, or fail in a way this build does not
  // recognize while the detail around it renders fine — and staying silent
  // there is indistinguishable from a pull request that runs no checks.
  if (query.isError) {
    return <DetailQueryError label={t.github.errors.checks} onRetry={query.refetch} />;
  }
  // Silent while loading and on every not-ok state: the detail view above has
  // already explained a lost connection, and a second copy of that explanation
  // in a 360px rail is noise.
  if (query.data?.state !== 'ok') return null;
  if (query.data.checks.length === 0) {
    return <p className="text-[10px] text-on-surface-variant">{t.github.empty.checks}</p>;
  }

  return (
    <div className="space-y-1">
      <MicroLabel as="h4">{t.github.panel.checks}</MicroLabel>
      <ul className="space-y-0.5">
        {/* Indexed keys because none of gh's own fields identify a row: `name`
            and `workflow` are both optional and normalized to '', and a matrix
            job repeats the same pair across several runs — so a composite key
            collides on exactly the pull requests with the most checks. */}
        {query.data.checks.map((check, index) => (
          <li
            key={`${index}:${check.workflow}/${check.name}`}
            className="flex items-center gap-1.5"
          >
            <StatusDot tone={CHECK_TONES[check.bucket]} />
            {/* A check with no link is ordinary — gh omits it on a queued run —
                and `href=""` would resolve to this page, so an empty link is
                plain text rather than an anchor that reloads the app. */}
            {check.link ? (
              <a
                href={check.link}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-0 flex-1 truncate text-[10px] text-on-surface hover:text-primary"
              >
                {check.name}
              </a>
            ) : (
              <span className="min-w-0 flex-1 truncate text-[10px] text-on-surface">
                {check.name}
              </span>
            )}
            <span className="shrink-0 text-[10px] text-on-surface-variant">
              {t.github.checkBucket[check.bucket]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The action this whole panel exists for: unresolved review comments, formatted
 * as a task and dropped straight into the composer.
 *
 * Through `composer-draft-store` rather than a prop chain — that seam exists
 * precisely so a sibling of the chat surface can fill the composer without
 * threading a setter through `ChatPage`.
 */
function ReviewThreadsAction({
  chatId,
  number,
}: {
  readonly chatId: string;
  readonly number: number;
}) {
  const { t } = useI18n();
  const query = useQuery(githubPrThreadsQueryOptions(chatId, number));

  // Same reasoning as `ChecksBlock`: this GraphQL read fails independently of
  // the detail above it, and the action this panel exists for silently missing
  // reads as "nothing to address" rather than as a failure.
  if (query.isError) {
    return <DetailQueryError label={t.github.errors.threads} onRetry={query.refetch} />;
  }
  if (query.data?.state !== 'ok') return null;

  const task = reviewThreadsToTask(
    query.data.threads,
    `${query.data.repo.nameWithOwner}#${number}`,
    t.github.reviewTask,
    query.data.truncated
  );

  // Empty means every thread is resolved or outdated, which is a different
  // sentence from "this pull request was never reviewed" but reads the same to
  // somebody looking for work to do.
  if (!task) {
    return <p className="text-[10px] text-on-surface-variant">{t.github.empty.threads}</p>;
  }

  const send = () => {
    // Appended rather than assigned, the same reasoning as the row menu's
    // paste-reference action: the composer may already hold unsent text, and
    // this task list is something to add to it, not overwrite.
    setComposerDraft(chatId, appendTask(chatId, task));
    requestComposerFocus();
  };

  return (
    <Button type="button" variant="secondary" size="sm" onClick={send} className="w-full">
      <MessageSquareQuote size={ICON_SM} />
      {t.github.actions.reviewCommentsToComposer}
    </Button>
  );
}

/**
 * Reads the draft at call time rather than at render time, the same reasoning
 * `appendReference` in `use-github-quick-actions` uses: the composer may have
 * gained a sentence since this row was painted. A blank line separates the two
 * rather than a space — `task` is itself a heading followed by a numbered
 * list, so joining it onto the end of a sentence would run a paragraph break
 * into the middle of a line.
 */
export function appendTask(chatId: string, task: string): string {
  const current = getComposerDraft(chatId);
  return current ? `${current.replace(/\s+$/, '')}\n\n${task}` : task;
}
