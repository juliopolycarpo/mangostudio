import type { ModelCatalogResponse, ModelOption } from '@mangostudio/shared/catalog';
import type { ProviderType } from '@mangostudio/shared/types';
import {
  Activity,
  Check,
  ChevronDown,
  Cpu,
  Lock,
  type LucideIcon,
  Sparkles,
  Zap,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { useMotionPresets } from '@/lib/motion/use-motion-presets';
import { cn } from '@/lib/utils';
import { getModelSelectorPlaceholder } from '../../utils/model-utils';

/** A glyph by tier, drawn in the row's own colour — the shape tells flash from pro, not a hue. */
function modelIcon(name: string): LucideIcon {
  const low = name.toLowerCase();
  if (low.includes('flash')) return Zap;
  if (low.includes('pro')) return Cpu;
  if (low.includes('lite')) return Activity;
  return Sparkles;
}

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
  const { popoverAbove } = useMotionPresets();
  const containerRef = useRef<HTMLDivElement>(null);
  const { t } = useI18n();

  const selectedModel = activeModels.find((m) => m.modelId === activeModel);
  const placeholder = getModelSelectorPlaceholder(modelCatalog, {
    loading: t.models.loading,
    unavailable: t.models.unavailable,
    noModelsAvailable: t.models.noModelsAvailable,
  });

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

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

  return (
    <div className="relative flex items-center" ref={containerRef}>
      <button
        type="button"
        onClick={handleToggle}
        disabled={isDisabled}
        aria-haspopup="listbox"
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
          <motion.div
            {...popoverAbove}
            /* Upward: this control lives in the composer at the foot of the
               viewport, and the downward panel it inherited from the header
               opened off the bottom of the screen. The panel clips and the
               list inside it scrolls, because `.dropdown-panel`'s own
               `overflow: hidden` is unlayered and beats any utility set on it. */
            className="dropdown-panel absolute bottom-full left-0 mb-2 w-80"
          >
            <div className="hide-scrollbar max-h-[60vh] space-y-1 overflow-y-auto p-1">
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
                      const Icon = modelIcon(model.displayName);
                      return (
                        <button
                          type="button"
                          key={model.modelId}
                          onClick={() => !isLocked && handleSelect(model.modelId)}
                          disabled={isLocked}
                          className={cn(
                            'flex min-h-8 w-full items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left transition-colors',
                            isLocked
                              ? 'cursor-not-allowed opacity-50'
                              : 'hover:bg-fill-hover active:bg-fill-pressed',
                            isSelected && 'bg-fill-selected'
                          )}
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="flex size-4 shrink-0 items-center justify-center text-fg-muted">
                              {isLocked ? <Lock size={ICON_MD} /> : <Icon size={ICON_MD} />}
                            </span>
                            <div className="min-w-0">
                              <div
                                className={cn(
                                  'truncate text-sm text-fg',
                                  isSelected && 'font-medium'
                                )}
                              >
                                {model.displayName}
                              </div>
                              {isPreview || showsReasoning ? (
                                <div className="mt-0.5 flex items-center gap-1">
                                  {isPreview && <Badge variant="neutral">{t.models.preview}</Badge>}
                                  {showsReasoning && (
                                    <Badge variant="neutral">{t.thinking.reasoningBadge}</Badge>
                                  )}
                                </div>
                              ) : null}
                            </div>
                          </div>
                          {isSelected && (
                            <Check size={ICON_MD} className="shrink-0 text-accent-fg" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
