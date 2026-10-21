import { ChevronRight, X } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { ICON_MD } from '@/lib/icon-sizes';

interface RailPanelProps {
  readonly title: string;
  readonly closeLabel: string;
  readonly closeMode: 'collapse' | 'close';
  readonly closeButtonRef?: Ref<HTMLButtonElement>;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

/** Shared panel chrome so every rail occupant has the same title and exit affordance. */
export function RailPanel({
  title,
  closeLabel,
  closeMode,
  closeButtonRef,
  onClose,
  children,
}: RailPanelProps) {
  const CloseIcon = closeMode === 'collapse' ? ChevronRight : X;

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-stroke px-4">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg" title={title}>
          {title}
        </h2>
        {/* A bare `<button>` rather than `Button`: the mobile drawer moves focus
            here on open, which needs the ref, and `Button` takes no `ref` prop. */}
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          title={closeLabel}
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-sm text-fg-muted transition-colors hover:bg-fill-hover hover:text-fg"
        >
          <CloseIcon size={ICON_MD} />
        </button>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
