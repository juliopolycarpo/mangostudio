import { isExternalAgentTargetId } from '@mangostudio/shared/external-agents';
import { useI18n } from '@/hooks/use-i18n';
import { EventRule } from './EventRule';

type Severity = 'info' | 'error';

/**
 * The vendor's product name, from a target id this build recognizes.
 *
 * A row written by a newer build naming a target this one has no label for
 * falls back to the raw id rather than to an empty sentence — it is a short
 * MangoStudio identifier, not vendor text, so rendering it is safe.
 */
function externalVendorLabel(
  targetId: string | undefined,
  t: ReturnType<typeof useI18n>['t']
): string {
  if (targetId && isExternalAgentTargetId(targetId)) return t.externalAgents.target[targetId];
  return targetId ?? '';
}

function resolveLabel(
  event: string,
  detail: string | undefined,
  t: ReturnType<typeof useI18n>['t']
): { label: string; severity: Severity } {
  switch (event) {
    case 'cursor_lost':
      return {
        label: t.chat.cursorLost.replace('{detail}', detail ?? ''),
        severity: 'info',
      };
    // Normally folded into the turn's error card by `MessageParts`, which says the
    // same failure; this draws only an event with no error part after it.
    case 'tool_loop_exhausted':
      return {
        label: detail ? `${t.chat.toolLoopExhausted} — ${detail}` : t.chat.toolLoopExhausted,
        severity: 'error',
      };
    case 'chat_compacted':
      return {
        label: t.chat.systemEvents.chatCompacted,
        severity: 'info',
      };
    case 'summary_handoff':
      return {
        label: t.chat.systemEvents.summaryHandoff,
        severity: 'info',
      };
    // `detail` is the target id, which is a MangoStudio value rather than
    // vendor text — the vendor's own name for itself never reaches here.
    case 'external_session_adopted':
      return {
        label: t.chat.systemEvents.externalSessionAdopted.replace(
          '{vendor}',
          externalVendorLabel(detail, t)
        ),
        severity: 'info',
      };
    // Legacy: Cursor now streams real tool_call/tool_result parts; this case
    // only renders historical persisted messages.
    case 'cursor_internal_tool_call':
      return {
        label: t.chat.systemEvents.cursorInternalToolCall.replace('{tool}', detail ?? ''),
        severity: 'info',
      };
    default:
      return { label: detail ?? event, severity: 'info' };
  }
}

export function SystemEventMarker({ event, detail }: { event: string; detail?: string }) {
  const { t } = useI18n();
  const { label, severity } = resolveLabel(event, detail, t);

  return <EventRule tone={severity === 'error' ? 'danger' : 'neutral'}>{label}</EventRule>;
}
