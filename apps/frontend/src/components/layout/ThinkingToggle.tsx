import type { ReasoningEffort } from '@mangostudio/shared';
import { Brain } from 'lucide-react';
import { ChipSelect } from '@/components/ui/ChipSelect';
import { useI18n } from '@/hooks/use-i18n';

interface ThinkingToggleProps {
  enabled: boolean;
  effort: ReasoningEffort;
  visible: boolean;
  onToggle: (enabled: boolean) => void;
  onEffortChange: (effort: ReasoningEffort) => void;
}

/**
 * The efforts this control offers, which is not the whole vocabulary.
 *
 * `xhigh` and `max` exist in `ReasoningEffort` and provider settings offers
 * them, filtered by the provider's own `supportedEfforts`. This chip has no
 * policy to filter against, so it stays on the three every reasoning provider
 * takes rather than offering one a provider would refuse — but it still has to
 * *name* an effort set elsewhere, which is why the label map below covers all
 * five while this list does not.
 */
const OFFERED_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high'];

export function ThinkingToggle({
  enabled,
  effort,
  visible,
  onToggle,
  onEffortChange,
}: ThinkingToggleProps) {
  const { t } = useI18n();

  if (!visible) return null;

  const effortLabels: Record<ReasoningEffort, string> = {
    low: t.thinking.effortLow,
    medium: t.thinking.effortMedium,
    high: t.thinking.effortHigh,
    xhigh: t.thinking.effortXHigh,
    max: t.thinking.effortMax,
  };

  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => onToggle(!enabled)}
        aria-pressed={enabled}
        // The on state is styled off `aria-pressed` in `index.css`, so it
        // follows the composer's runner accent rather than the product primary.
        className="composer-chip"
      >
        <Brain size={12} className="shrink-0" />
        <span>{t.thinking.enable}</span>
      </button>

      {/* Effort selector — only visible when reasoning is on */}
      {enabled ? (
        <ChipSelect
          value={effort}
          options={OFFERED_EFFORTS.map((candidate) => ({
            value: candidate,
            label: effortLabels[candidate],
          }))}
          onChange={(next) => onEffortChange(next as ReasoningEffort)}
          ariaLabel={t.thinking.effort}
          // An effort set from provider settings can sit outside the offered
          // three; the chip has to say which one it is rather than round it
          // down to the nearest thing in its own list.
          placeholder={effortLabels[effort]}
          className="max-w-[9rem]"
          panelClassName="w-40"
        />
      ) : null}
    </div>
  );
}
