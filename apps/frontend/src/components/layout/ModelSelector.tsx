import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check, Sparkles, Cpu, Zap, Activity } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import type { GeminiModelOption, GeminiModelCatalogResponse } from '@mangostudio/shared';
import { getModelSelectorPlaceholder } from '../../utils/gemini-models';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface ModelSelectorProps {
  activeModel: string;
  activeModels: GeminiModelOption[];
  isDisabled: boolean;
  onSelect: (modelId: string) => void;
  geminiModelCatalog: GeminiModelCatalogResponse;
}

export function ModelSelector({
  activeModel,
  activeModels,
  isDisabled,
  onSelect,
  geminiModelCatalog,
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedModel = activeModels.find((m) => m.modelId === activeModel);
  const placeholder = getModelSelectorPlaceholder(geminiModelCatalog);

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

  const displayedModels = activeModels;

  // Group models by major family
  const families = displayedModels.reduce(
    (acc, model) => {
      let family = 'Other';
      if (model.displayName.toLowerCase().includes('gemini 3.1')) family = 'Gemini 3.1';
      else if (model.displayName.toLowerCase().includes('gemini 3')) family = 'Gemini 3';
      else if (model.displayName.toLowerCase().includes('gemini 2.5')) family = 'Gemini 2.5';
      else if (model.displayName.toLowerCase().includes('gemini 2.0')) family = 'Gemini 2.0';
      else if (model.displayName.toLowerCase().includes('gemini')) family = 'Gemini';

      if (!acc[family]) acc[family] = [];
      acc[family].push(model);
      return acc;
    },
    {} as Record<string, GeminiModelOption[]>
  );

  const getModelIcon = (name: string) => {
    const low = name.toLowerCase();
    if (low.includes('flash')) return <Zap className="w-3.5 h-3.5 text-amber-400" />;
    if (low.includes('pro')) return <Cpu className="w-3.5 h-3.5 text-primary" />;
    if (low.includes('lite')) return <Activity className="w-3.5 h-3.5 text-emerald-400" />;
    return <Sparkles className="w-3.5 h-3.5 text-blue-400" />;
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={handleToggle}
        disabled={isDisabled}
        className={cn(
          'flex items-center gap-2 px-3 py-1.5 rounded-lg transition-all duration-200 border border-transparent',
          'group hover:bg-surface-container-high active:scale-95',
          isOpen && 'bg-surface-container-high border-primary/20',
          isDisabled && 'opacity-50 cursor-not-allowed'
        )}
      >
        <span className="font-headline text-lg font-bold tracking-tight text-on-background group-hover:text-primary transition-colors">
          {selectedModel?.displayName || placeholder}
        </span>
        <ChevronDown
          className={cn(
            'w-4 h-4 text-on-background/40 group-hover:text-primary transition-all duration-200',
            isOpen && 'rotate-180 text-primary'
          )}
        />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.95 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute left-0 top-full mt-2 w-72 max-h-[70vh] glass-panel border border-outline-variant/20 rounded-xl shadow-2xl overflow-hidden z-[100] hide-scrollbar overflow-y-auto"
          >
            <div className="py-2">
              {Object.keys(families).length === 0 ? (
                <div className="px-4 py-3 text-sm text-on-surface-variant italic">
                  No models available
                </div>
              ) : (
                Object.entries(families).map(([family, models]) => (
                  <div key={family} className="mb-2 last:mb-0">
                    <div className="px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant/50">
                      {family}
                    </div>
                    {models.map((model) => (
                      <button
                        key={model.modelId}
                        onClick={() => handleSelect(model.modelId)}
                        className={cn(
                          'w-full flex items-center justify-between px-4 py-2.5 text-left transition-all duration-150',
                          'hover:bg-primary/10 active:bg-primary/20 group/item',
                          activeModel === model.modelId && 'bg-primary/5'
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex-shrink-0 w-5 h-5 flex items-center justify-center">
                            {getModelIcon(model.displayName)}
                          </div>
                          <div>
                            <div
                              className={cn(
                                'text-sm font-medium transition-colors',
                                activeModel === model.modelId
                                  ? 'text-primary'
                                  : 'text-on-surface group-hover/item:text-on-surface'
                              )}
                            >
                              {model.displayName}
                            </div>
                            {model.modelId.includes('preview') && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-container-highest text-on-surface-variant border border-outline-variant/30">
                                Preview
                              </span>
                            )}
                          </div>
                        </div>
                        {activeModel === model.modelId && (
                          <Check className="w-4 h-4 text-primary" />
                        )}
                      </button>
                    ))}
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
