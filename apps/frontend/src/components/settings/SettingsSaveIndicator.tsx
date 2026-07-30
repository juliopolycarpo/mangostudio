import { AlertCircle, Check } from 'lucide-react';
import { useAppSettingsSaveStatus } from '@/features/settings/app/use-app-settings-save-status';
import { useI18n } from '@/hooks/use-i18n';

/**
 * Auto-save feedback for the settings header. There is no Save button to report
 * against, so the write has to announce itself: silence would be the only
 * difference between a persisted change and a dropped one.
 */
export function SettingsSaveIndicator() {
  const { t } = useI18n();
  const status = useAppSettingsSaveStatus();

  if (status === 'idle') return null;

  const label = t.settings.autoSave[status];
  const tone = status === 'error' ? 'text-error' : 'text-on-surface-variant';

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs ${tone}`}
      role="status"
      aria-live="polite"
    >
      {status === 'saving' && (
        <span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
      )}
      {status === 'saved' && <Check size={14} />}
      {status === 'error' && <AlertCircle size={14} />}
      {label}
    </span>
  );
}
