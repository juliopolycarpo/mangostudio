import { Ellipsis } from 'lucide-react';

import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';

import { TimelineItem } from '../TimelineItem';
import { TimelineRow } from '../TimelineRow';

/**
 * A trailing row saying the turn has not gone idle, for whatever gap no
 * event describes: no `system_event` for "still waiting on the API",
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
        disclosable={false}
        glyph={<Ellipsis size={ICON_SM} className="animate-pulse shrink-0" />}
      >
        <span className="animate-pulse text-fg-muted">{t.chat.feed.statusWorking}</span>
      </TimelineRow>
    </TimelineItem>
  );
}
