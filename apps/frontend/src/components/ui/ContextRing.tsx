import type { ContextSeverity } from '@mangostudio/shared/chat';
import { useI18n } from '@/hooks/use-i18n';

interface ContextRingProps {
  ratio: number;
  severity: ContextSeverity;
  /**
   * Draws the percentage inside the ring. Turn it off where the caller prints
   * the figure beside the ring in running text, as the composer's chip does: a
   * digit that fits a 20px ring is 8px tall, which nobody reads at arm's length.
   */
  showValue?: boolean;
}

/**
 * Arc colour per band. A record rather than a ternary chain so adding a sixth
 * band to the schema is a type error here instead of a ring that silently
 * stays green.
 *
 * `normal` and `info` are `fg`, not the accent: mango is for the primary
 * action, the current item and focus, and a healthy 62% is none of them. It
 * also sat a shade from `warning`, so a ring that had escalated barely looked
 * different from one that had not. `fg` over the `fg-subtle` track is 2.5:1 or
 * better in both themes; `fg-muted` would not clear the track.
 */
const SEVERITY_STROKE: Record<ContextSeverity, string> = {
  normal: 'stroke-fg',
  info: 'stroke-fg',
  warning: 'stroke-warning',
  danger: 'stroke-danger',
  critical: 'stroke-danger',
};

/**
 * Tiny circular progress ring for context usage.
 *
 * With the figure inside it the ring is 20px on every surface: the composer
 * briefly drew a smaller one and it was the wrong lever, since what made the
 * chip unreadable was contrast, not diameter. Without the figure
 * (`showValue={false}`) it is a 16px glyph, the size of the icons around it.
 *
 * Callers that already name the ring — a button with its own `aria-label`, or
 * an `aria-hidden` wrapper — swallow the SVG `<title>` below, which is what
 * both of the current call sites do.
 */
export function ContextRing({ ratio, severity, showValue = true }: ContextRingProps) {
  const { t } = useI18n();
  const size = showValue ? 20 : 16;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - Math.min(ratio, 1));
  const pct = Math.round(ratio * 100);

  const color = SEVERITY_STROKE[severity];

  return (
    <div
      className="relative flex items-center justify-center shrink-0"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90">
        <title>{t.common.contextIndicator}</title>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          // A tenth of an opacity was enough on the sidebar's own surface and
          // vanished on the composer's accent-tinted band: with nothing to see
          // but a 1px arc, a chat under 15% of its window read as an empty gap
          // where the chip should be. The track is the thing that says "there
          // is a ring here" at every value, so it has to survive both surfaces.
          className="stroke-fg-subtle"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          className={color}
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </svg>
      {/* The number carries the value at low percentages, where the arc is a
          dot; `fg` rather than the muted variant because 8px of muted text is
          not a number anyone reads. It is a glyph drawn inside the ring, not
          running text, which is why it is below the type scale's floor — and
          why the composer, which has room, prints its figure beside the ring
          at a real size instead. */}
      {showValue && (
        <span className="absolute text-[8px] font-semibold tabular-nums text-fg">{pct}</span>
      )}
    </div>
  );
}
