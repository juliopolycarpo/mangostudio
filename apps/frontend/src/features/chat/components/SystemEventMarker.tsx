import { isExternalAgentTargetId } from '@mangostudio/shared/external-agents';
import { useI18n } from '@/hooks/use-i18n';

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

  const toneClass = severity === 'error' ? 'text-error/80' : 'text-on-surface-variant/60';
  const lineClass = severity === 'error' ? 'bg-error/30' : 'bg-outline-variant/20';

  return (
    <div className={`flex items-center gap-2 py-2 text-xs my-1 ${toneClass}`}>
      <div className={`flex-1 h-px ${lineClass}`} />
      <span className="font-medium whitespace-nowrap">{label}</span>
      <div className={`flex-1 h-px ${lineClass}`} />
    </div>
  );
}
