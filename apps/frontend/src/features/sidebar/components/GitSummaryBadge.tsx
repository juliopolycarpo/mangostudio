/**
 * The compact git line on a sidebar row: a branch glyph that turns into a
 * warning "branch plus" while the tree is dirty, and — only where the sidebar
 * is wide enough to read them — the branch (or short detached hash) and the
 * ↑/↓ counts when the branch has drifted from its upstream. Fed by the batched
 * `/git/state/batch` summaries — this must never cost a per-row request.
 *
 * Narrow, the glyph is the whole badge. A branch label squeezed to "c…" says
 * nothing and costs the title the room it needed, so the words move to the
 * tooltip and to assistive tech, which get all of them at every width.
 */

import type { GitSummary } from '@mangostudio/shared/git';
import { GitBranch, GitBranchPlus } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { usePlural } from '@/hooks/use-plural';
import { branchLabel } from '@/lib/git-branch';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

interface GitSummaryBadgeProps {
  readonly summary: GitSummary;
  /** Room for the branch name and the ahead/behind figures beside the glyph. */
  readonly expanded: boolean;
}

export function GitSummaryBadge({ summary, expanded }: GitSummaryBadgeProps) {
  const { t } = useI18n();
  const plural = usePlural();
  const branch = branchLabel(summary.branch, summary.detachedAt);
  if (!branch) return null;
  const dirty = summary.changedFileCount > 0;
  const dirtyLabel = dirty
    ? plural(
        { one: t.sidebar.git.dirtyOne, other: t.sidebar.git.dirtyOther },
        summary.changedFileCount
      )
    : null;
  const drifted = summary.ahead > 0 || summary.behind > 0;
  const counts = { ahead: String(summary.ahead), behind: String(summary.behind) };
  const sync = drifted ? formatMessage(t.git.remote.syncSummary, counts) : null;
  const syncLabel = drifted ? formatMessage(t.sidebar.git.sync, counts) : null;
  // Everything the badge knows, once, in words. The tooltip repeats it for a
  // pointer and the sr-only copy for a screen reader; whatever is drawn is
  // `aria-hidden`, so nothing is read twice and nothing hangs on a colour.
  const description = [branch, dirtyLabel, syncLabel].filter(Boolean).join(' · ');
  const Glyph = dirty ? GitBranchPlus : GitBranch;
  return (
    // `overflow-hidden`: when the row bounds this badge, what does not fit is
    // clipped at its own edge instead of painting over the runner label next to it.
    <span
      className="flex min-w-0 items-center gap-1 overflow-hidden"
      data-testid="git-summary-badge"
      title={description}
    >
      {/* Two cues for a dirty tree that are not the same colour as the runner dot
          beside it: a different glyph, and the warning hue. */}
      <Glyph
        size={ICON_SM}
        aria-hidden="true"
        className={cn('shrink-0', dirty && 'text-warning')}
      />
      {expanded ? (
        // Absorbs the squeeze first (the huge shrink factor, against the figures'
        // 1), so the label ellipsizes before the counts lose room.
        <span aria-hidden="true" className="max-w-24 shrink-[100000] truncate">
          {branch}
        </span>
      ) : null}
      {expanded && sync ? (
        // The figures drop whole instead of being cut mid-glyph: a fixed one-line
        // box whose wrapped item lands on a second, clipped line (`gap-y-4` pushes
        // it past `h-4`). The leading zero-width item always fits, so a figure
        // that does not fit wraps rather than being the first item and showing a
        // sliver; its negative end margin cancels the gap after it.
        <span
          aria-hidden="true"
          className="flex h-4 min-w-0 flex-wrap content-start items-center gap-x-1 gap-y-4 overflow-hidden"
        >
          <span className="-me-1 h-4 w-0" />
          <span className="flex h-4 shrink-0 items-center">{sync}</span>
        </span>
      ) : null}
      <span className="sr-only">{description}</span>
    </span>
  );
}
