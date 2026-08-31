import { Ellipsis } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { TimelineItem } from '../TimelineItem';
import { TimelineRow } from '../TimelineRow';

/**
 * A trailing row saying the turn has not gone idle, for whatever gap no
 * vendor event describes: no `system_event` for "still waiting on the API",
 * no delta for a long `Bash` between chunks of output, nothing at all for the
 * pause between one tool call ending and the next one starting.
 *
 * // Usage: {showWorkingIndicator ? <TurnWorkingRow /> : null}
 */
export function TurnWorkingRow() {
  const { t } = useI18n();
  return (
    <TimelineItem tone="active">
      <TimelineRow
        expanded={false}
        onToggle={() => undefined}
        disclosable={false}
        glyph={<Ellipsis size={11} className="animate-pulse shrink-0" />}
      >
        <span className="animate-pulse text-on-surface-variant">
          {t.externalAgents.turn.working}
        </span>
      </TimelineRow>
    </TimelineItem>
  );
}
