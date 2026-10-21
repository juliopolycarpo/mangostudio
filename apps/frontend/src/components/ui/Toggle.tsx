import type { InputHTMLAttributes } from 'react';

type ToggleSwitchProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

/**
 * The switch itself — a 36×20 track with a 12px knob — with no label of its
 * own. Off is a `control` track with the control line and a muted knob; on is
 * the accent with the knob in `on-accent`. The knob does not grow on hover and
 * carries no shadow.
 *
 * Use it where a surrounding element already names the control (a settings row
 * that is itself the `<label>`); everywhere else use `Toggle`, which brings its
 * own label.
 *
 * Usage: <ToggleSwitch checked={on} onChange={…} aria-label={label} />
 */
export function ToggleSwitch({ checked, defaultChecked, ...props }: ToggleSwitchProps) {
  const isChecked = checked ?? defaultChecked ?? false;

  return (
    <span className="group relative inline-flex shrink-0">
      <input
        type="checkbox"
        role="switch"
        className="peer sr-only"
        aria-checked={isChecked}
        checked={checked}
        defaultChecked={defaultChecked}
        {...props}
      />
      <span
        aria-hidden="true"
        className="
          relative inline-block h-5 w-9 shrink-0 rounded-full
          border border-stroke-strong bg-control
          transition-colors
          peer-checked:border-accent peer-checked:bg-accent
          peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus
          peer-disabled:cursor-not-allowed peer-disabled:opacity-50
          after:absolute after:left-[3px] after:top-[3px] after:size-3 after:rounded-full
          after:bg-fg-muted after:content-[''] after:transition-transform after:duration-(--duration-base)
          group-hover:after:bg-fg
          peer-checked:after:translate-x-4 peer-checked:after:bg-on-accent
          peer-checked:group-hover:after:bg-on-accent
        "
      />
    </span>
  );
}

interface ToggleProps extends ToggleSwitchProps {
  label: string;
}

/** The preference switch with its label to the right. */
export function Toggle({ label, id, ...props }: ToggleProps) {
  const inputId = id ?? label.toLowerCase().replace(/\s+/g, '-');

  return (
    <label htmlFor={inputId} className="inline-flex cursor-pointer items-center gap-3">
      <ToggleSwitch id={inputId} {...props} />
      <span className="select-none text-sm text-fg">{label}</span>
    </label>
  );
}
