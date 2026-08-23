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
        'inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded border border-outline-variant/40 bg-surface-container-high px-1 font-mono text-[10px] leading-none text-on-surface-variant',
        className
      )}
    >
      {/* Hidden from the accessible name: the shortcut hint must not rename the
          button it sits in ("Send", not "Send ⏎"). */}
      <span aria-hidden="true">{keys}</span>
    </kbd>
  );
}
