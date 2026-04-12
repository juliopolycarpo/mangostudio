import { useI18n } from '@/hooks/use-i18n';

export function SystemEventMarker({ event, detail }: { event: string; detail?: string }) {
  const { t } = useI18n();

  let label: string;
  if (event === 'cursor_lost') {
    label = t.chat.cursorLost.replace('{detail}', detail ?? '');
  } else {
    label = detail ?? event;
  }

  return (
    <div className="flex items-center gap-2 py-2 text-xs text-on-surface-variant/60 my-1">
      <div className="flex-1 h-px bg-outline-variant/20" />
      <span className="font-medium whitespace-nowrap">{label}</span>
      <div className="flex-1 h-px bg-outline-variant/20" />
    </div>
  );
}
