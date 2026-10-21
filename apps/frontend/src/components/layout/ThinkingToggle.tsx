import type { ReasoningEffort } from '@mangostudio/shared/types';
import { Brain } from 'lucide-react';
import { ChipSelect } from '@/components/ui/ChipSelect';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';

interface ThinkingToggleProps {
  enabled: boolean;
  effort: ReasoningEffort;
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

export function ThinkingToggle({ enabled, effort, onToggle, onEffortChange }: ThinkingToggleProps) {
  const { t } = useI18n();

  const effortLabels: Record<ReasoningEffort, string> = {
    low: t.thinking.effortLow,
    medium: t.thinking.effortMedium,
    high: t.thinking.effortHigh,
    xhigh: t.thinking.effortXHigh,
    max: t.thinking.effortMax,
  };

  return (
    // Two chips on the composer's status line, returned as a fragment so both
    // are children of that strip and it draws its `·` between them and around
    // them the way it does between every other pair. Each sits in a slot: the
    // strip draws its dot inside the child, and a bare chip as the child put
    // the dot in its own padding and inside its pressed wash.
    <>
      <span className="flex items-center">
        <button
          type="button"
          onClick={() => onToggle(!enabled)}
          aria-pressed={enabled}
          // The on state is styled off `aria-pressed` in `index.css`: a
          // `fill-selected` wash and the icon in the composer's runner colour.
          // The effort chip that appears beside it is the third cue.
          className="composer-chip"
        >
          <Brain size={ICON_SM} className="shrink-0" />
          {/* The strip's dialect: its keys are lowercase (`model:`, `effort:`). */}
          <span className="composer-chip-key">{t.thinking.enable}</span>
        </button>
      </span>

      {/* Effort selector — only visible when reasoning is on */}
      {enabled ? (
        <ChipSelect
          value={effort}
          options={OFFERED_EFFORTS.map((candidate) => ({
            value: candidate,
            label: effortLabels[candidate],
          }))}
          onChange={(next) => onEffortChange(next as ReasoningEffort)}
          // `effort: medium`, the way the external runner's chip reads: both
          // runners state this setting as a key and a value, in the same key.
          label={t.chat.input.effortLabel}
          ariaLabel={t.thinking.effort}
          // An effort set from provider settings can sit outside the offered
          // three; the chip has to say which one it is rather than round it
          // down to the nearest thing in its own list.
          placeholder={effortLabels[effort]}
          className="max-w-[11rem]"
          panelClassName="w-40"
        />
      ) : null}
    </>
  );
}
