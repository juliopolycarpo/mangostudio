import type { ReactNode } from 'react';
import { Checkbox } from '@/components/ui/Checkbox';
import { cn } from '@/lib/utils';

interface CheckboxRowProps {
  /** What the option is called (`text-sm`, 500). */
  readonly label: ReactNode;
  /** A technical second line in mono — an identifier, a slug. */
  readonly description?: ReactNode;
  readonly checked: boolean;
  /** Also dims the row when an enclosing `<fieldset disabled>` turns the box off. */
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly className?: string;
}

/**
 * One option in a pick-several list: a checkbox and its name in a `control`
 * row that is the whole click target. The checked box is the only accent — the
 * row stays neutral, so a screenful of them does not turn into a field of mango.
 *
 * // Usage: <CheckboxRow label={tool.title} description={tool.name} checked={on} onChange={setOn} />
 */
export function CheckboxRow({
  label,
  description,
  checked,
  disabled,
  onChange,
  className,
}: CheckboxRowProps) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-sm border border-stroke bg-control px-3 py-2 transition-colors hover:bg-control-hover',
        'has-disabled:cursor-not-allowed has-disabled:opacity-50 has-disabled:hover:bg-control',
        className
      )}
    >
      {/* The row carries the disabled fade, so the box does not fade a second time. */}
      <Checkbox
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 has-disabled:opacity-100"
      />
      <span className="min-w-0 flex-1">
        <span className="block break-words text-sm font-medium text-fg">{label}</span>
        {description ? (
          <span className="block truncate font-mono text-micro text-fg-muted">{description}</span>
        ) : null}
      </span>
    </label>
  );
}
