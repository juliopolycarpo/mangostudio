interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  /**
   * Names the wait for a screen reader, which a bare ring cannot do. Pass it
   * wherever the spinner stands alone — a page, a region, a pending list —
   * and leave it off where words already sit beside it ("Saving…", "Reading
   * the repository…"): the ring is then decoration, and a second status would
   * announce the same wait twice.
   */
  label?: string;
}

const sizes = {
  sm: 'w-4 h-4',
  md: 'w-6 h-6',
  lg: 'w-10 h-10',
};

/**
 * A 2px ring with an `accent` arc. The track is `stroke-strong`, not the
 * hairline: `stroke` is a divider colour, and on the light theme's white
 * surfaces the ring it drew was close to invisible, leaving a lone arc.
 *
 * With a `label` it is a `role="status"` carrying that text, hidden from sight.
 * Without one it is `aria-hidden`: a spinner with no name has nothing to say.
 *
 * // Usage: <Spinner size="lg" label={t.common.loading} />
 */
export function Spinner({ size = 'md', className = '', label }: SpinnerProps) {
  return (
    <div
      role={label ? 'status' : undefined}
      aria-hidden={label ? undefined : true}
      className={`${sizes[size]} rounded-full border-2 border-stroke-strong border-t-accent animate-spin ${className}`}
    >
      {label ? <span className="sr-only">{label}</span> : null}
    </div>
  );
}
