import { CircleX } from 'lucide-react';
import { type InputHTMLAttributes, useId } from 'react';

import { ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  /** Replaces `hint` while set: a field shows the one message it needs most. */
  error?: string;
  /**
   * What the field expects — the length of a password, the format of an id.
   * Sits under the field in `fg-muted` and is wired to it as its description,
   * so a screen reader reads it with the label. It is the instruction, which a
   * placeholder never is, and it is not part of the label, which only names.
   */
  hint?: string;
}

/**
 * The text field every form shares: 32px, a hairline on three sides and the
 * stronger control line underneath (the line that says "this is a field", at
 * 3:1). Focus swaps the border for the focus colour and adds a 1px ring, so it
 * reads at the same weight as the focus outline on every other control.
 */
export const FIELD_CLASS =
  'h-8 w-full rounded-sm border border-stroke border-b-stroke-strong bg-control px-3 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:bg-control-hover focus:outline-none focus:border-focus focus:ring-1 focus:ring-focus disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger aria-invalid:border-b-danger';

export function Input({
  label,
  error,
  hint,
  id,
  className,
  'aria-describedby': describedBy,
  ...props
}: InputProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  // One message under the field at a time, and it is the one the field is
  // described by: an error replaces the hint rather than stacking on it.
  const messageId = error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined;
  const description = [describedBy, messageId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={fieldId} className="text-sm font-medium text-fg">
          {label}
        </label>
      )}
      <input
        id={fieldId}
        aria-invalid={error ? true : undefined}
        aria-describedby={description}
        className={cn(FIELD_CLASS, className)}
        {...props}
      />
      {error ? (
        <p id={messageId} className="flex items-center gap-1 text-xs text-danger">
          <CircleX size={ICON_SM} className="shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : hint ? (
        <p id={messageId} className="text-xs text-fg-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
