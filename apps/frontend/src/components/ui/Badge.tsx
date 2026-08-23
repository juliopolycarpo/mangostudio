import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type BadgeVariant = 'neutral' | 'success' | 'warning' | 'error' | 'accent';

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const variantStyles: Record<BadgeVariant, string> = {
  neutral: 'bg-surface-container-highest text-on-surface-variant',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  error: 'bg-error/10 text-error',
  accent: 'bg-primary/10 text-primary',
};

/** Small status label: PR state, runtime health, session runner. */
export function Badge({ variant = 'neutral', className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 font-label text-[10px] font-bold uppercase tracking-widest',
        variantStyles[variant],
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}
