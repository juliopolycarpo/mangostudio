/**
 * Composer affordance for the read-only capability inspector: the chip, and the
 * popover it opens. The popover's body (`CapabilityPanel`, the sections and
 * rows) is a lazy chunk: it is only worth its bytes once someone opens the
 * popover, and hovering or focusing the chip already starts the fetch.
 * All eligibility is resolved server-side; see `CapabilityPanel` for how it
 * renders.
 */

import { useQuery } from '@tanstack/react-query';
import { ListChecks, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';

import { createLazyOverlay } from '@/components/layout/LazyOverlay';
import { Callout } from '@/components/ui/Callout';
import { ComposerPopover } from '@/components/ui/ComposerPopover';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { useDismissable } from '@/hooks/use-dismissable';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';

import type { ChatCapabilitiesSelection } from '../hooks/use-chat-capabilities';
import { chatCapabilitiesQueryOptions } from '../hooks/use-chat-capabilities';
import type { CapabilityPanelProps } from './CapabilityPanel';

const capabilityPanel = createLazyOverlay<CapabilityPanelProps>(() =>
  import('./CapabilityPanel').then((module) => ({ default: module.CapabilityPanel }))
);

interface CapabilityInspectorProps {
  chatId: string | null;
  disabled?: boolean;
  activeModel?: string | null;
  selectedAgentId?: string;
}

export function CapabilityInspector({
  chatId,
  disabled,
  activeModel,
  selectedAgentId,
}: CapabilityInspectorProps) {
  const { t } = useI18n();
  const labels = t.chat.capabilities;
  const [open, setOpen] = useState(false);
  const { containerRef, triggerRef, onKeyDown } = useDismissable(open, () => setOpen(false));

  const selection: ChatCapabilitiesSelection = {
    chatId: chatId ?? '',
    ...(activeModel ? { model: activeModel } : {}),
    ...(selectedAgentId ? { agentId: selectedAgentId } : {}),
  };
  const capabilitiesQuery = useQuery({
    ...chatCapabilitiesQueryOptions(selection),
    enabled: open && !!chatId,
  });

  return (
    // Not `relative`: the panel is anchored to the composer, not to this chip.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Escape is handled for the trigger and the panel it owns, both inside this wrapper.
    <div ref={containerRef} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        onPointerEnter={capabilityPanel.preload}
        onFocus={capabilityPanel.preload}
        disabled={disabled}
        aria-expanded={open}
        className="composer-chip composer-tool-chip"
        title={labels.title}
      >
        <SlidersHorizontal size={ICON_SM} className="shrink-0" />
        <span className="hidden sm:inline">{labels.button}</span>
      </button>

      {open && (
        <ComposerPopover
          anchor={triggerRef}
          className="app-scrollbar max-h-96 space-y-3 overflow-y-auto p-3"
        >
          <MicroLabel as="p" className="flex items-center gap-1.5">
            <ListChecks size={ICON_SM} />
            {labels.title}
          </MicroLabel>

          {!chatId && <p className="text-xs text-fg-muted">{labels.needsChat}</p>}
          {chatId && capabilitiesQuery.isLoading && (
            <p className="text-xs text-fg-muted">{t.common.loading}</p>
          )}
          {chatId && capabilitiesQuery.isError && (
            <Callout tone="danger" role="alert" title={labels.loadError} />
          )}
          {chatId && capabilitiesQuery.data && (
            <capabilityPanel.Overlay
              capabilities={capabilitiesQuery.data}
              labels={labels}
              onLoadFailed={() => setOpen(false)}
            />
          )}
        </ComposerPopover>
      )}
    </div>
  );
}
