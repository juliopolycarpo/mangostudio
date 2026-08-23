import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface ChipProps {
  /** The key of the key:value pair, rendered muted (`model: gpt-5.6`). */
  label?: string;
  icon?: ReactNode;
  title?: string;
  'aria-label'?: string;
  disabled?: boolean;
  /** When present the chip renders as a button; otherwise as a plain span. */
  onClick?: () => void;
  className?: string;
  children: ReactNode;
}

/**
 * Terminal-style key:value pill. Styling lives in the `.terminal-chip`
 * component class so call-site utilities can override single properties.
 */
export function Chip({
  label,
  icon,
  title,
  'aria-label': ariaLabel,
  disabled,
  onClick,
  className,
  children,
}: ChipProps) {
  const content = (
    <>
      {icon}
      {label ? <span className="shrink-0 text-on-surface-variant/70">{label}:</span> : null}
      <span className="truncate text-on-surface">{children}</span>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        className={cn(
          'terminal-chip cursor-pointer transition-colors hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-60',
          className
        )}
      >
        {content}
      </button>
    );
  }
  return (
    <span title={title} className={cn('terminal-chip', className)}>
      {content}
    </span>
  );
}
