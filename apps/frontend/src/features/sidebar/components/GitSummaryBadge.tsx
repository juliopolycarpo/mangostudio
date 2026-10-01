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
import { branchLabel } from '@/lib/git-branch';
import { formatMessage } from '@/lib/i18n-format';

export function GitSummaryBadge({ summary }: { summary: GitSummary }) {
  const { t } = useI18n();
  const branch = branchLabel(summary.branch, summary.detachedAt);
  if (!branch) return null;
  const dirtyLabel =
    summary.changedFileCount > 0
      ? formatMessage(t.sidebar.git.dirty, { count: String(summary.changedFileCount) })
      : null;
  const drifted = summary.ahead > 0 || summary.behind > 0;
  const counts = { ahead: String(summary.ahead), behind: String(summary.behind) };
  const sync = drifted ? formatMessage(t.git.remote.syncSummary, counts) : null;
  const syncLabel = drifted ? formatMessage(t.sidebar.git.sync, counts) : null;
  const hasTail = dirtyLabel !== null || sync !== null;
  return (
    // `overflow-hidden`: when the row bounds this badge, what does not fit is
    // clipped at its own edge instead of painting over the runner label next to it.
    <span
      className="flex min-w-0 items-center gap-1 overflow-hidden"
      data-testid="git-summary-badge"
    >
      <GitBranch size={10} aria-hidden="true" className="shrink-0" />
      {/* Absorbs the squeeze first (the huge shrink factor, against the tail's 1),
          so the label ellipsizes before the markers lose room. */}
      <span className="max-w-24 shrink-[100000] truncate" title={branch}>
        {branch}
      </span>
      {hasTail ? (
        // The markers behind the branch drop whole instead of being cut mid-glyph:
        // a fixed one-line box whose wrapped items land on a second, clipped line
        // (`gap-y-4` pushes it past `h-4`). The leading zero-width item always fits,
        // so a marker that does not fit wraps rather than being the first item and
        // showing a sliver; its negative end margin cancels the gap after it. The text
        // stays in the DOM (`sr-only`) either way.
        <span className="flex h-4 min-w-0 flex-wrap content-start items-center gap-x-1 gap-y-4 overflow-hidden">
          <span aria-hidden="true" className="-me-1 h-4 w-0" />
          {dirtyLabel ? (
            <span className="flex h-4 shrink-0 items-center" title={dirtyLabel}>
              <StatusDot tone="warning" />
              <span className="sr-only">{dirtyLabel}</span>
            </span>
          ) : null}
          {sync ? (
            // The glyphs carry the meaning visually and read as bare arrows aloud,
            // so they are hidden and paired with the spelled-out count.
            <span className="flex h-4 shrink-0 items-center" title={syncLabel ?? undefined}>
              <span aria-hidden="true">{sync}</span>
              <span className="sr-only">{syncLabel}</span>
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
