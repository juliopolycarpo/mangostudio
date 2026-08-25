/**
 * The header's cockpit line: `in <workdir basename> / <branch>`, with a quiet
 * warning dot while the tree is dirty.
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
}

export function WorkspaceBreadcrumb({ chatId, workdir }: WorkspaceBreadcrumbProps) {
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
    />
  );
}

export function WorkspaceBreadcrumbView({
  basename,
  branch,
  dirty,
}: {
  basename: string;
  branch: string | null;
  dirty: boolean;
}) {
  const { t } = useI18n();
  return (
    <span
      className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-on-surface-variant"
      data-testid="workspace-breadcrumb"
    >
      <span className="shrink-0 text-on-surface-variant/60">{t.workspace.breadcrumbIn}</span>
      <span className="truncate font-medium text-on-surface">{basename}</span>
      {branch ? (
        <>
          <span className="shrink-0 text-on-surface-variant/60">/</span>
          <span className="truncate text-primary">{branch}</span>
        </>
      ) : null}
      {dirty ? (
        <span className="flex shrink-0 items-center" title={t.workspace.breadcrumbDirty}>
          <StatusDot tone="warning" />
          <span className="sr-only">{t.workspace.breadcrumbDirty}</span>
        </span>
      ) : null}
    </span>
  );
}
