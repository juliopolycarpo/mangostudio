import { cn } from '@/lib/utils';

export type StatusDotTone = 'accent' | 'success' | 'warning' | 'error' | 'neutral';

const toneStyles: Record<StatusDotTone, string> = {
  accent: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-error',
  neutral: 'bg-outline',
};

interface StatusDotProps {
  tone: StatusDotTone;
  /** A dot that is getting somewhere (connecting, probing) rather than being there. */
  pulse?: boolean;
  className?: string;
}

/** Colored presence dot. Purely decorative — pair it with visible or sr-only text. */
export function StatusDot({ tone, pulse = false, className }: StatusDotProps) {
  return (
    <span
      aria-hidden="true"
      data-tone={tone}
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        toneStyles[tone],
        pulse && 'animate-pulse',
        className
      )}
    />
  );
}
