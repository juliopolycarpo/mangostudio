import { ChevronRight, X } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { Button } from '@/components/ui/Button';
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
        <Button
          ref={closeButtonRef}
          type="button"
          variant="subtle"
          size="icon-sm"
          onClick={onClose}
          aria-label={closeLabel}
          title={closeLabel}
          className="shrink-0 text-fg-muted hover:text-fg"
        >
          <CloseIcon size={ICON_MD} />
        </Button>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
