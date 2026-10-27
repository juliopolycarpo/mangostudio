/**
 * The app's checkbox.
 *
 * Twenty-odd settings rows drew a native box tinted with `accent-accent`,
 * which is not a design-system control: `accent-color` recolours the tick and
 * the fill and leaves the platform to draw everything else, so the same
 * setting is a rounded macOS square, a flat Windows one, and a Chromium one
 * that ignores the surrounding radius and border scale entirely.
 *
 * The input keeps its own box — `appearance: none` plus real dimensions —
 * rather than hiding behind a `sr-only` proxy, so the thing the pointer hits
 * is the thing the browser checks, with or without a wrapping `<label>`. The
 * tick is a sibling the input's `:checked` state reveals, because a void
 * element has no reliable content box of its own to draw into.
 *
 * Usage: <Checkbox checked={enabled} onChange={(e) => setEnabled(e.target.checked)} aria-label={label} />
 */

import { Check } from 'lucide-react';
import type { InputHTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
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
  "peer relative size-4 shrink-0 cursor-pointer appearance-none rounded-xs border border-stroke-strong bg-control transition-colors checked:border-accent checked:bg-accent enabled:hover:bg-control-hover enabled:checked:hover:bg-accent-hover disabled:cursor-not-allowed pointer-coarse:after:absolute pointer-coarse:after:-inset-3 pointer-coarse:after:content-['']";

export function Checkbox({ className, ...props }: CheckboxProps) {
  return (
    // The disabled fade sits on the wrapper, not the input: dimming the box
    // alone would leave a full-strength tick floating on a faded square.
    <span className={cn('relative inline-flex shrink-0 has-disabled:opacity-50', className)}>
      <input type="checkbox" className={BOX} {...props} />
      <Check
        size={12}
        strokeWidth={3}
        aria-hidden="true"
        // `inset-0 m-auto` centres it over the box without depending on the
        // wrapper's own alignment, which every call site sets differently.
        className="pointer-events-none absolute inset-0 m-auto text-on-accent opacity-0 transition-opacity peer-checked:opacity-100"
      />
    </span>
  );
}
