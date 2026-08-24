/**
 * The compact git line on a sidebar row: branch (or short detached hash), a
 * warning dot while the tree is dirty, and ↑/↓ counts when the branch has
 * drifted from its upstream. Fed by the batched `/git/state/batch` summaries —
 * this must never cost a per-row request.
 */

import type { GitSummary } from '@mangostudio/shared/git';
import { GitBranch } from 'lucide-react';
import { StatusDot } from '@/components/ui/StatusDot';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';

export function GitSummaryBadge({ summary }: { summary: GitSummary }) {
  const { t } = useI18n();
  const branch = summary.branch ?? summary.detachedAt?.slice(0, 7) ?? null;
  if (!branch) return null;
  const dirtyLabel =
    summary.changedFileCount > 0
      ? formatMessage(t.sidebar.git.dirty, { count: String(summary.changedFileCount) })
      : null;
  const drifted = summary.ahead > 0 || summary.behind > 0;
  const counts = { ahead: String(summary.ahead), behind: String(summary.behind) };
  const sync = drifted ? formatMessage(t.git.remote.syncSummary, counts) : null;
  const syncLabel = drifted ? formatMessage(t.sidebar.git.sync, counts) : null;
  return (
    <span className="flex min-w-0 items-center gap-1" data-testid="git-summary-badge">
      <GitBranch size={10} aria-hidden="true" className="shrink-0" />
      <span className="max-w-24 truncate" title={branch}>
        {branch}
      </span>
      {dirtyLabel ? (
        <span className="flex shrink-0 items-center" title={dirtyLabel}>
          <StatusDot tone="warning" />
          <span className="sr-only">{dirtyLabel}</span>
        </span>
      ) : null}
      {sync ? (
        // The glyphs carry the meaning visually and read as bare arrows aloud,
        // so they are hidden and paired with the spelled-out count.
        <span className="flex shrink-0 items-center" title={syncLabel ?? undefined}>
          <span aria-hidden="true">{sync}</span>
          <span className="sr-only">{syncLabel}</span>
        </span>
      ) : null}
    </span>
  );
}
