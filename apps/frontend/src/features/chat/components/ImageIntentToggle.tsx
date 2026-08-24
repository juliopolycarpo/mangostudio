import { Image } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';

/**
 * "Use the image tool for this turn." A hint to the model rather than a mode
 * switch, which is why it is a pressable chip beside the other tool
 * affordances and not a segmented control.
 */
export function ImageIntentToggle({
  active,
  disabled,
  onChange,
}: {
  active: boolean;
  disabled?: boolean;
  onChange: (active: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={() => onChange(!active)}
      disabled={disabled}
      aria-pressed={active}
      title={t.chat.input.createImagesHint}
      className={`terminal-chip h-7 shrink-0 transition-colors disabled:opacity-50 ${
        active
          ? 'border-primary/40 bg-primary/15 text-primary'
          : 'hover:border-outline-variant hover:text-on-surface'
      }`}
    >
      <Image size={12} className="shrink-0" />
      <span className="hidden sm:inline">{t.chat.input.createImages}</span>
    </button>
  );
}
