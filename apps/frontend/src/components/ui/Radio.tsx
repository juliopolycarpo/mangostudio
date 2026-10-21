/**
 * The app's radio button: `Checkbox`'s box with a round face, so the two read as
 * one family. The same reasons apply — `accent-color` recolours the dot and
 * leaves the platform to draw the rest, and a native radio ignores the control
 * line and the focus ring — so the input keeps its own `appearance: none` box and
 * the dot is a sibling its `:checked` state reveals.
 *
 * Usage: <Radio name="mode" value="new" checked={mode === 'new'} onChange={…} aria-label={label} />
 */

import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Layout for the control as a whole — margins and alignment, not size. */
  readonly className?: string;
}

/**
 * `after:` widens the hit area on a touch screen without moving anything: the
 * 44px floor in `index.css` skips this input so its drawn box stays 16px, and a
 * pseudo-element of the input is part of the input, so a tap on it checks the
 * box with or without a wrapping `<label>`. 12px each way makes a 40px target.
 */
const BOX =
  "peer relative size-4 shrink-0 cursor-pointer appearance-none rounded-full border border-stroke-strong bg-control transition-colors checked:border-accent checked:bg-accent enabled:hover:bg-control-hover enabled:checked:hover:bg-accent-hover disabled:cursor-not-allowed pointer-coarse:after:absolute pointer-coarse:after:-inset-3 pointer-coarse:after:content-['']";

export function Radio({ className, ...props }: RadioProps) {
  return (
    // The disabled fade sits on the wrapper, as it does for `Checkbox`.
    <span className={cn('relative inline-flex shrink-0 has-disabled:opacity-50', className)}>
      <input type="radio" className={BOX} {...props} />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 m-auto size-1.5 rounded-full bg-on-accent opacity-0 peer-checked:opacity-100"
      />
    </span>
  );
}
