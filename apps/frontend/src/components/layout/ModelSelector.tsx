import type { ModelCatalogResponse, ModelOption, ProviderType } from '@mangostudio/shared';
import { Activity, Check, ChevronDown, Cpu, Lock, Sparkles, Zap } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { useMotionPresets } from '@/lib/motion/use-motion-presets';
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

  const getModelIcon = (name: string) => {
    const low = name.toLowerCase();
    if (low.includes('flash')) return <Zap className="w-3.5 h-3.5 text-amber-400" />;
    if (low.includes('pro')) return <Cpu className="w-3.5 h-3.5 text-primary" />;
    if (low.includes('lite')) return <Activity className="w-3.5 h-3.5 text-emerald-400" />;
    return <Sparkles className="w-3.5 h-3.5 text-blue-400" />;
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
        // follows the composer's runner accent rather than the product primary.
        className={cn(
          'composer-chip group max-w-[13rem]',
          isDisabled && 'opacity-50 cursor-not-allowed'
        )}
      >
        <span className="composer-chip-key text-on-surface-variant/70">{`${t.chat.input.modelLabel}:`}</span>
        <span className="composer-chip-value composer-chip-runner">
          {selectedModel?.displayName || placeholder}
        </span>
        <ChevronDown
          className={cn(
            'size-3 shrink-0 text-on-surface-variant/50 transition-transform duration-200',
            isOpen && 'rotate-180 text-current'
          )}
        />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            {...popoverAbove}
            /* Upward: this control lives in the composer at the foot of the
               viewport, and the downward panel it inherited from the header
               opened off the bottom of the screen. */
            className="dropdown-panel absolute left-0 bottom-full mb-2 w-[19rem] max-h-[60vh] hide-scrollbar overflow-y-auto"
          >
            <div className="py-2">
              {Object.keys(groups).length === 0 ? (
                <div className="px-4 py-3 text-sm text-on-surface-variant italic">
                  {t.models.noModelsAvailable}
                </div>
              ) : (
                Object.entries(groups).map(([providerKey, models]) => (
                  <div key={providerKey} className="mb-2 last:mb-0">
                    <div className="px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant/50">
                      {getProviderLabel(providerKey)}
                    </div>
                    {models.map((model) => {
                      const isLocked = lockedProvider != null && model.provider !== lockedProvider;
                      return (
                        <button
                          type="button"
                          key={model.modelId}
                          onClick={() => !isLocked && handleSelect(model.modelId)}
                          disabled={isLocked}
                          className={cn(
                            'w-full flex items-center justify-between px-4 py-2.5 text-left transition-all duration-150',
                            !isLocked && 'hover:bg-primary/10 active:bg-primary/20 group/item',
                            activeModel === model.modelId && !isLocked && 'bg-primary/5',
                            isLocked && 'opacity-40 cursor-not-allowed'
                          )}
                        >
                          <div className="flex items-center gap-3">
                            <div className="flex-shrink-0 w-5 h-5 flex items-center justify-center">
                              {isLocked ? (
                                <Lock className="w-3.5 h-3.5 text-on-surface-variant" />
                              ) : (
                                getModelIcon(model.displayName)
                              )}
                            </div>
                            <div>
                              <div
                                className={cn(
                                  'text-sm font-medium transition-colors',
                                  activeModel === model.modelId && !isLocked
                                    ? 'text-primary'
                                    : 'text-on-surface group-hover/item:text-on-surface'
                                )}
                              >
                                {model.displayName}
                              </div>
                              <div className="flex items-center gap-1.5">
                                {model.modelId.includes('preview') && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-container-highest text-on-surface-variant border border-outline-variant/30">
                                    {t.models.preview}
                                  </span>
                                )}
                                {model.capabilities?.reasoning && !isLocked && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary border border-primary/30">
                                    {t.thinking.reasoningBadge}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                          {activeModel === model.modelId && !isLocked && (
                            <Check className="w-4 h-4 text-primary" />
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
