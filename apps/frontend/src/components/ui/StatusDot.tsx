import { cn } from '@/lib/utils';

export type StatusDotTone = 'accent' | 'success' | 'warning' | 'error' | 'neutral';

const toneStyles: Record<StatusDotTone, string> = {
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-danger',
  neutral: 'bg-stroke-strong',
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
        'inline-block size-2 shrink-0 rounded-full',
        toneStyles[tone],
        pulse && 'animate-pulse',
        className
      )}
    />
  );
}
