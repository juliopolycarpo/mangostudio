import { useI18n } from '@/hooks/use-i18n';

interface ContextRingProps {
  ratio: number;
  severity: string;
}

/**
 * Tiny circular progress ring for context usage.
 *
 * One size for every surface. The composer briefly drew a smaller one and it
 * was the wrong lever: what made the chip unreadable was contrast, not
 * diameter, and two sizes only meant two sets of numbers to keep legible.
 *
 * Callers that already name the ring — a button with its own `aria-label`, or
 * an `aria-hidden` wrapper — swallow the SVG `<title>` below, which is what
 * both of the current call sites do.
 */
export function ContextRing({ ratio, severity }: ContextRingProps) {
  const { t } = useI18n();
  const size = 20;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - Math.min(ratio, 1));
  const pct = Math.round(ratio * 100);

  const color =
    severity === 'critical' || severity === 'danger'
      ? 'stroke-error'
      : severity === 'warning'
        ? 'stroke-warning'
        : 'stroke-primary';

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
          className="stroke-on-surface/25"
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
          dot; `on-surface` rather than the muted variant because 8px of muted
          text on a tinted band is not a number anyone reads. */}
      <span className="absolute text-[8px] font-bold tabular-nums text-on-surface">{pct}</span>
    </div>
  );
}
