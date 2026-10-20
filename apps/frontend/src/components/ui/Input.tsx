import { CircleX } from 'lucide-react';
import type { InputHTMLAttributes } from 'react';
import { ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

/**
 * The text field every form shares: 32px, a hairline on three sides and the
 * stronger control line underneath (the line that says "this is a field", at
 * 3:1). Focus swaps the border for the focus colour and adds a 1px ring, so it
 * reads at the same weight as the focus outline on every other control.
 */
export const FIELD_CLASS =
  'h-8 w-full rounded-sm border border-stroke border-b-stroke-strong bg-control px-3 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:bg-control-hover focus:outline-none focus:border-focus focus:ring-1 focus:ring-focus disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger aria-invalid:border-b-danger';

export function Input({ label, error, id, className, ...props }: InputProps) {
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
      )}
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        className={cn(FIELD_CLASS, className)}
        {...props}
      />
      {error && (
        <p className="flex items-center gap-1 text-xs text-danger">
          <CircleX size={ICON_SM} className="shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}
