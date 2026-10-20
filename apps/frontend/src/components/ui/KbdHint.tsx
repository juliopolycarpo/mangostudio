import { cn } from '@/lib/utils';

interface KbdHintProps {
  /** The shortcut as displayed: `⌘K`, `⏎`, `Esc`. */
  keys: string;
  className?: string;
}

/** Keyboard shortcut chip, sized to sit inside buttons and menu rows. */
export function KbdHint({ keys, className }: KbdHintProps) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-xs border border-stroke bg-control px-1 font-mono text-micro font-medium leading-none text-fg-muted',
        className
      )}
    >
      {/* Hidden from the accessible name: the shortcut hint must not rename the
          button it sits in ("Send", not "Send ⏎"). */}
      <span aria-hidden="true">{keys}</span>
    </kbd>
  );
}
