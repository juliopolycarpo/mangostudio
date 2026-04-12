interface ContextRingProps {
  ratio: number;
  severity: string;
}

/** Tiny circular progress ring for context usage. */
export function ContextRing({ ratio, severity }: ContextRingProps) {
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
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          className="stroke-on-surface/10"
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
      <span className="absolute text-[7px] font-bold tabular-nums text-on-surface-variant">
        {pct}
      </span>
    </div>
  );
}
