import type { InputHTMLAttributes } from 'react';

interface ToggleProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
}

/**
 * The preference switch: a 36×20 track with a 12px knob. Off is a `control`
 * track with the control line and a muted knob; on is the accent with the
 * knob in `on-accent`. The knob does not grow on hover and carries no shadow.
 */
export function Toggle({ label, id, checked, defaultChecked, ...props }: ToggleProps) {
  const inputId = id ?? label.toLowerCase().replace(/\s+/g, '-');
  const isChecked = checked ?? defaultChecked ?? false;

  return (
    <label htmlFor={inputId} className="group inline-flex cursor-pointer items-center gap-3">
      <input
        id={inputId}
        type="checkbox"
        role="switch"
        className="peer sr-only"
        aria-checked={isChecked}
        checked={checked}
        defaultChecked={defaultChecked}
        {...props}
      />
      <span
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
      <span className="select-none text-sm text-fg">{label}</span>
    </label>
  );
}
