import type { LucideIcon } from 'lucide-react';
import { ChevronRight, X } from 'lucide-react';
import type { ReactNode, Ref } from 'react';

interface RailPanelProps {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly closeLabel: string;
  readonly closeMode: 'collapse' | 'close';
  readonly closeButtonRef?: Ref<HTMLButtonElement>;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

/** Shared panel chrome so every rail occupant has the same title and exit affordance. */
export function RailPanel({
  icon: Icon,
  title,
  closeLabel,
  closeMode,
  closeButtonRef,
  onClose,
  children,
}: RailPanelProps) {
  const CloseIcon = closeMode === 'collapse' ? ChevronRight : X;

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-container-low">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-outline-variant/15 px-4">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Icon size={15} />
        </span>
        <h2 className="min-w-0 flex-1 truncate text-sm font-bold text-on-surface" title={title}>
          {title}
        </h2>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          title={closeLabel}
          className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary"
        >
          <CloseIcon size={16} />
        </button>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
