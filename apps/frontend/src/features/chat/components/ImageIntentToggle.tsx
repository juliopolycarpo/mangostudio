import { Check, Image } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';

/**
 * "Use the image tool for this turn." A hint to the model rather than a mode
 * switch, which is why it is a pressable chip beside the other tool
 * affordances and not a segmented control.
 *
 * Nothing else on the strip says whether the next turn will force the tool, so
 * "on" is more than a fill: `index.css` tints the icon in the runner's colour
 * and a check follows the label once there is a label to follow. Below `sm` the
 * label is hidden and the tint and the fill carry it alone.
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
      className="composer-chip composer-tool-chip"
    >
      <Image size={ICON_SM} className="shrink-0" />
      <span className="hidden sm:inline">{t.chat.input.createImages}</span>
      {active ? (
        <Check size={ICON_SM} aria-hidden="true" className="hidden shrink-0 sm:block" />
      ) : null}
    </button>
  );
}
