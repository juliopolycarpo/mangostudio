import type { ModelCatalogResponse, ModelOption } from '@mangostudio/shared/catalog';
import type { ProviderType } from '@mangostudio/shared/types';
import { Check, ChevronDown, Lock } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { ComposerPopover } from '@/components/ui/ComposerPopover';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { useDismissable } from '@/hooks/use-dismissable';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

import { getModelSelectorPlaceholder } from '../../utils/model-utils';

interface ModelSelectorProps {
  activeModel: string;
  activeModels: ModelOption[];
  isDisabled: boolean;
  onSelect: (modelId: string) => void;
  modelCatalog: ModelCatalogResponse;
  lockedProvider?: ProviderType | null;
}

export function ModelSelector({
  activeModel,
  activeModels,
  isDisabled,
  onSelect,
  modelCatalog,
  lockedProvider,
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { containerRef, triggerRef, onKeyDown } = useDismissable(isOpen, () => setIsOpen(false));
  const { t } = useI18n();

  const selectedModel = activeModels.find((m) => m.modelId === activeModel);
  const placeholder = getModelSelectorPlaceholder(modelCatalog, {
    loading: t.models.loading,
    unavailable: t.models.unavailable,
    noModelsAvailable: t.models.noModelsAvailable,
  });

  const handleToggle = () => {
    if (!isDisabled) setIsOpen(!isOpen);
  };

  const handleSelect = (modelId: string) => {
    onSelect(modelId);
    setIsOpen(false);
  };

  // Group models by provider
  const groups = activeModels.reduce(
    (acc, model) => {
      const key: string = model.provider ?? 'other';
      if (!acc[key]) acc[key] = [];
      acc[key].push(model);
      return acc;
    },
    {} as Record<string, ModelOption[]>
  );

  const getProviderLabel = (key: string): string => {
    if (key in t.providers) return t.providers[key as ProviderType];
    return key;
  };

  // Said once for the whole list rather than under every locked group: the
  // reason is the same sentence for all of them, and it names the one provider
  // the chat is tied to. Only when a row is actually locked — a catalog with
  // nothing else in it has no padlock to explain.
  const lockReason =
    lockedProvider != null && activeModels.some((model) => model.provider !== lockedProvider)
      ? formatMessage(t.models.providerLocked, { provider: getProviderLabel(lockedProvider) })
      : null;

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Escape is handled for the trigger and the panel it owns, both inside this wrapper.
    <div className="flex items-center" ref={containerRef} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        disabled={isDisabled}
        // `true`, not `listbox`: the panel is grouped (provider headings, a
        // lock reason, badges, rows that cannot be chosen) and its rows are
        // plain buttons, so promising a listbox's arrow-key model would be a
        // claim nothing here keeps.
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-label={t.chat.input.modelLabel}
        // The open state is styled off `aria-expanded` in `index.css`, so it
        // follows the composer's runner accent rather than the product accent.
        className="composer-chip max-w-[13rem] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="composer-chip-key text-fg-muted">{`${t.chat.input.modelLabel}:`}</span>
        <span className="composer-chip-value composer-chip-runner">
          {selectedModel?.displayName || placeholder}
        </span>
        <ChevronDown size={ICON_SM} className="shrink-0" />
      </button>

      <AnimatePresence>
        {isOpen && (
          <ComposerPopover
            animated
            anchor={triggerRef}
            className="app-scrollbar max-h-[60vh] space-y-1 overflow-y-auto p-1"
          >
            {lockReason ? <p className="px-2 pt-1 text-xs text-fg-muted">{lockReason}</p> : null}
            {Object.keys(groups).length === 0 ? (
              <div className="px-2 py-2 text-sm text-fg-muted">{t.models.noModelsAvailable}</div>
            ) : (
              Object.entries(groups).map(([providerKey, models]) => (
                <div key={providerKey}>
                  <MicroLabel as="div" className="px-2 pb-1 pt-2">
                    {getProviderLabel(providerKey)}
                  </MicroLabel>
                  {models.map((model) => {
                    const isLocked = lockedProvider != null && model.provider !== lockedProvider;
                    const isSelected = activeModel === model.modelId && !isLocked;
                    const isPreview = model.modelId.includes('preview');
                    const showsReasoning = model.capabilities?.reasoning && !isLocked;
                    return (
                      <button
                        type="button"
                        key={model.modelId}
                        onClick={() => !isLocked && handleSelect(model.modelId)}
                        disabled={isLocked}
                        className={cn(
                          'flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left transition-colors',
                          // A locked row is not faded: its name says which models
                          // exist, and the line at the top says why they are out
                          // of reach. The name steps down a text colour instead.
                          isLocked
                            ? 'cursor-not-allowed'
                            : 'hover:bg-fill-hover active:bg-fill-pressed',
                          isSelected && 'bg-fill-selected'
                        )}
                      >
                        {/* The one mark a row ever wears, and only when the chat's
                            provider rules it out. While any row is locked the slot
                            is held for every row so names keep one left edge; a
                            list with no lock starts its names at the row's own
                            inset, like every other composer menu. The provider
                            heading already says who makes the model. */}
                        {lockReason ? (
                          <span className="flex size-4 shrink-0 items-center justify-center text-fg-muted">
                            {isLocked ? <Lock size={ICON_MD} /> : null}
                          </span>
                        ) : null}
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate text-sm',
                            isLocked ? 'text-fg-muted' : 'text-fg',
                            isSelected && 'font-medium'
                          )}
                        >
                          {model.displayName}
                        </span>
                        {/* On the row's own line, ahead of the check: a badge on a
                            second line made every reasoning model 22px taller than
                            its neighbours and broke the list's rhythm. */}
                        {isPreview && <Badge variant="neutral">{t.models.preview}</Badge>}
                        {showsReasoning && (
                          <Badge variant="neutral">{t.thinking.reasoningBadge}</Badge>
                        )}
                        {isSelected && <Check size={ICON_MD} className="shrink-0 text-accent-fg" />}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </ComposerPopover>
        )}
      </AnimatePresence>
    </div>
  );
}
