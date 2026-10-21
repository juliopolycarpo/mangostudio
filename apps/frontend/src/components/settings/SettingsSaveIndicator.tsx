import { Check, CircleX } from 'lucide-react';
import { Spinner } from '@/components/ui/Spinner';
import { useAppSettingsSaveStatus } from '@/features/settings/app/use-app-settings-save-status';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

/**
 * Auto-save feedback for the settings page header. There is no Save button to
 * report against, so the write has to announce itself: silence would be the
 * only difference between a persisted change and a dropped one. The glyph
 * carries the state and the word repeats it, so colour is never the signal.
 */
export function SettingsSaveIndicator() {
  const { t } = useI18n();
  const status = useAppSettingsSaveStatus();

  if (status === 'idle') return null;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-xs',
        status === 'error' ? 'text-danger' : 'text-fg-muted'
      )}
      role="status"
      aria-live="polite"
    >
      {status === 'saving' && <Spinner size="sm" />}
      {status === 'saved' && <Check size={ICON_SM} className="text-success" aria-hidden="true" />}
      {status === 'error' && <CircleX size={ICON_SM} aria-hidden="true" />}
      {t.settings.autoSave[status]}
    </span>
  );
}
