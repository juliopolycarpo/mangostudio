/**
 * How much of the model's window this chat has spent, as a composer chip.
 *
 * The same ring an external agent gets, drawn from the tracker's own ratio and
 * severity: the strip should not spell `context: 9.6k/1.0M` onto a wrapped line
 * for one runner and draw a ring for another. Escalation is the ring's colour,
 * and it stays quiet until the tracker says otherwise — a context figure that
 * shouts at 20% teaches people to ignore it at 95%.
 */

import { ContextUsageChip } from '@/components/ui/ContextUsageChip';
import type { ContextInfo } from '@/features/generation/types';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';

type ContextLabels = ReturnType<typeof useI18n>['t']['chat']['context'];

/** Every mode the tracker can report, named rather than leaked as its id. */
function modeLabel(mode: ContextInfo['mode'], labels: ContextLabels): string {
  switch (mode) {
    case 'stateful':
      return labels.modeStateful;
    case 'stateless-loop':
      return labels.modeStatelessLoop;
    case 'replay':
      return labels.modeReplay;
    case 'compacted':
      return labels.modeCompacted;
    case 'degraded':
      return labels.modeDegraded;
  }
}

export function ContextBadge({ info }: { info: ContextInfo }) {
  const { t } = useI18n();
  const labels = t.chat.context;

  return (
    <ContextUsageChip
      ratio={info.estimatedUsageRatio}
      severity={info.severity}
      testId="context-badge"
      lines={[
        {
          key: 'tokens',
          label: labels.label,
          // Grouped in full rather than compacted: this is the panel you opened
          // to see the actual number, and `9.6k` is what the ring already said.
          value: formatMessage(labels.tokens, {
            used: info.estimatedInputTokens.toLocaleString(),
            limit: info.contextLimit.toLocaleString(),
          }),
          testId: 'context-badge-tokens',
        },
        {
          key: 'mode',
          label: labels.modeLabel,
          value: modeLabel(info.mode, labels),
          testId: 'context-badge-mode',
        },
      ]}
    />
  );
}
