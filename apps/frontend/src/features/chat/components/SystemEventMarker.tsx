import { useI18n } from '@/hooks/use-i18n';

type Severity = 'info' | 'error';

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
