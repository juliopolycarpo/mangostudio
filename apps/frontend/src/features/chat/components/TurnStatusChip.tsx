import type { Messages } from '@mangostudio/shared/i18n';
import { useI18n } from '@/hooks/use-i18n';
import type { TurnPhase } from '../lib/turn-status';

type FeedLabels = Messages['chat']['feed'];

/** One word for each phase a live turn can be in. A settled turn says nothing. */
function phaseLabel(phase: Exclude<TurnPhase, 'settled'>, labels: FeedLabels): string {
  if (phase === 'thinking') return labels.statusThinking;
  if (phase === 'responding') return labels.statusResponding;
  if (phase === 'awaiting-user') return labels.statusAwaitingUser;
  return labels.statusWorking;
}

interface TurnStatusChipProps {
  phase: TurnPhase;
  /**
   * True while the step-level filler row is showing. The chip yields to it,
   * never the reverse: the row is the older and more specific statement, and
   * two things saying "working" a few pixels apart read as two things happening.
   */
  showWorkingRow: boolean;
}

/**
 * What the turn is doing right now, beside the name of who is doing it.
 *
 * Deliberately at a different altitude from the timeline below it: the chip
 * names the *turn's* phase, while a caret marks *which part* is receiving
 * tokens. Streaming prose gets both, and they are not a repeat of each other.
 *
 * Usage: <TurnStatusChip phase={status.phase} showWorkingRow={status.showWorkingRow} />
 */
export function TurnStatusChip({ phase, showWorkingRow }: TurnStatusChipProps) {
  const { t } = useI18n();
  if (phase === 'settled' || showWorkingRow) return null;

  return (
    <span className="shrink-0 animate-pulse rounded-full bg-surface-container-high px-1.5 py-0.5 text-[10px] text-on-surface-variant/80">
      {phaseLabel(phase, t.chat.feed)}
    </span>
  );
}
