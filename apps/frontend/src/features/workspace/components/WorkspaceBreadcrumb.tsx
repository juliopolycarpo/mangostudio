/**
 * The header's cockpit line: `in <workdir basename> / <branch>`, with a warning
 * dot and, from `md` up, the word "Modified" while the tree is dirty. A dot
 * alone is a colour doing a word's job: pale yellow in dark, rust in light,
 * unexplained to anyone who is not hovering it.
 *
 * Reads the same `git-state` query the workspace rail subscribes to, so when
 * the rail is open this costs nothing new; when it is closed, one cached query
 * keeps the header honest. Degrades a segment at a time: no repo → no branch,
 * no workdir at all → nothing.
 */

import type { GitRepoState } from '@mangostudio/shared/git';
import { StatusDot } from '@/components/ui/StatusDot';
import { useGitRealtimeInvalidation, useGitState } from '@/features/workspace/hooks/use-git-state';
import { useI18n } from '@/hooks/use-i18n';
import { branchLabel } from '@/lib/git-branch';
import { formatMessage } from '@/lib/i18n-format';
import { workdirBasename } from '@/lib/paths';

interface WorkspaceBreadcrumbProps {
  /** Must be a real chat id — the caller gates the mount on one existing. */
  chatId: string;
  /**
   * The chat's workdir. The caller gates the mount on one, the same way the
   * workspace rail gates its Git panel: without a workdir the hooks below still
   * cost a `git/state` request and a topic subscription for a render that ends
   * in `null`.
   */
  workdir: string | null;
  /**
   * Opens the workdir picker. The breadcrumb is the workdir's home now that the
   * composer chip is gone, so this is where changing it lives — offered only
   * while the caller says the chat can still move.
   */
  onChangeWorkdir?: () => void;
}

export function WorkspaceBreadcrumb({
  chatId,
  workdir,
  onChangeWorkdir,
}: WorkspaceBreadcrumbProps) {
  // Subscribed here as well as in the rail, because this is the mount that
  // survives: the rail unmounts when it is collapsed, on Todos and on mobile,
  // and a breadcrumb reading a query nobody invalidates goes quietly stale.
  // Topic subscriptions are ref-counted per tab, so a second subscriber costs
  // no extra socket traffic and the rail's unmount does not cancel this one.
  useGitRealtimeInvalidation(chatId);
  // Re-declared with the contract type: the query result's `data` alias
  // defeats the compiler's discriminant narrowing without it.
  const state: GitRepoState | undefined = useGitState(chatId).data;
  const repo = state?.state === 'repo' ? state : null;
  const basename = workdirBasename(repo?.workdir ?? workdir);
  if (!basename) return null;
  const branch = repo ? branchLabel(repo.status.branch.name, repo.status.branch.detachedAt) : null;
  return (
    <WorkspaceBreadcrumbView
      basename={basename}
      branch={branch}
      dirty={repo ? !repo.status.clean : false}
      {...(onChangeWorkdir ? { onChangeWorkdir } : {})}
    />
  );
}

export function WorkspaceBreadcrumbView({
  basename,
  branch,
  dirty,
  onChangeWorkdir,
}: {
  basename: string;
  branch: string | null;
  dirty: boolean;
  onChangeWorkdir?: () => void;
}) {
  const { t } = useI18n();
  return (
    <span
      className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-fg-muted"
      data-testid="workspace-breadcrumb"
    >
      <span className="shrink-0">{t.workspace.breadcrumbIn}</span>
      {onChangeWorkdir ? (
        <button
          type="button"
          onClick={onChangeWorkdir}
          aria-label={formatMessage(t.workspace.changeWorkdir, { name: basename })}
          className="-mx-1 cursor-pointer truncate rounded-sm px-1 font-medium text-fg transition-colors hover:bg-fill-hover"
        >
          {basename}
        </button>
      ) : (
        <span className="truncate font-medium text-fg">{basename}</span>
      )}
      {branch ? (
        <>
          <span className="shrink-0 text-fg-subtle">/</span>
          <span className="truncate">{branch}</span>
        </>
      ) : null}
      {dirty ? (
        // The full phrase stays the tooltip and the screen-reader text; the
        // visible word is the short one, so the line still fits beside the
        // branch. Below `md` there is no room for it and the dot stands with its
        // tooltip, as before.
        <span className="flex shrink-0 items-center gap-1.5" title={t.workspace.breadcrumbDirty}>
          <StatusDot tone="warning" />
          <span className="sr-only">{t.workspace.breadcrumbDirty}</span>
          <span aria-hidden="true" className="hidden md:inline">
            {t.workspace.breadcrumbDirtyShort}
          </span>
        </span>
      ) : null}
    </span>
  );
}
