import { ChevronRight, X } from 'lucide-react';
import { createContext, type ReactNode, type Ref, useContext, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/Button';
import { ICON_MD } from '@/lib/icon-sizes';

/**
 * The header's trailing slot, handed to whatever panel is mounted inside. Null
 * until the header has mounted, and for content rendered outside a `RailPanel`.
 */
const RailPanelActionsSlot = createContext<HTMLElement | null>(null);

/**
 * Puts a panel's own controls (refresh, an overflow menu) in the rail header,
 * level with the collapse chevron, instead of in a bar of their own below it.
 *
 * The header belongs to `RailPanel` so every occupant has the same title and
 * exit; the controls belong to the panel, which owns the state they act on. A
 * portal lets both be true without the panel growing a second header row.
 * Renders nothing outside a `RailPanel`.
 *
 * @example
 * <RailPanelActions><IconButton label={t.git.refresh} onClick={refresh}>…</IconButton></RailPanelActions>
 */
export function RailPanelActions({ children }: { readonly children: ReactNode }) {
  const slot = useContext(RailPanelActionsSlot);
  return slot ? createPortal(children, slot) : null;
}

interface RailPanelProps {
  readonly title: string;
  readonly closeLabel: string;
  readonly closeMode: 'collapse' | 'close';
  readonly closeButtonRef?: Ref<HTMLButtonElement>;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

/**
 * Shared panel chrome so every rail occupant has the same title and exit affordance.
 *
 * The header is 48px (`h-12`) with a `text-base` title, the app header's own
 * height, so the two borders share one rhythm; `foundations.md` has no 44px step
 * and gives `text-base` to section titles.
 */
export function RailPanel({
  title,
  closeLabel,
  closeMode,
  closeButtonRef,
  onClose,
  children,
}: RailPanelProps) {
  const CloseIcon = closeMode === 'collapse' ? ChevronRight : X;
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-stroke px-4">
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-fg" title={title}>
          {title}
        </h2>
        <div className="flex shrink-0 items-center gap-1">
          {/* `contents`: the panel's buttons become siblings of the close button. */}
          <div ref={setActionsSlot} className="contents" />
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
        </div>
      </header>
      <RailPanelActionsSlot value={actionsSlot}>
        <div className="min-h-0 flex-1">{children}</div>
      </RailPanelActionsSlot>
    </div>
  );
}
