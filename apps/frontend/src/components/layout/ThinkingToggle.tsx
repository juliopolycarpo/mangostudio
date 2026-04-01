import { useState, useRef, useEffect } from 'react';
import { Brain, ChevronDown, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useI18n } from '@/hooks/use-i18n';
import type { ReasoningEffort } from '@mangostudio/shared';

interface ThinkingToggleProps {
  enabled: boolean;
  effort: ReasoningEffort;
  visible: boolean;
  onToggle: (enabled: boolean) => void;
  onEffortChange: (effort: ReasoningEffort) => void;
}

export function ThinkingToggle({
  enabled,
  effort,
  visible,
  onToggle,
  onEffortChange,
}: ThinkingToggleProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setIsOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  if (!visible) return null;

  const efforts: ReasoningEffort[] = ['low', 'medium', 'high'];
  const effortLabels: Record<ReasoningEffort, string> = {
    low: t.thinking.effortLow,
    medium: t.thinking.effortMedium,
    high: t.thinking.effortHigh,
  };

  return (
    <div className="relative" ref={ref}>
      <div className="flex items-center gap-1.5">
        {/* Reasoning toggle button — pill style matching the rest of the app */}
        <button
          type="button"
          onClick={() => onToggle(!enabled)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 ${
            enabled
              ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30 hover:bg-amber-500/20'
              : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest border border-outline-variant/20 hover:text-on-surface'
          }`}
        >
          <Brain size={13} />
          <span>{t.thinking.enable}</span>
        </button>

        {/* Effort selector — only visible when reasoning is on */}
        {enabled && (
          <button
            type="button"
            onClick={() => setIsOpen(!isOpen)}
            className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface transition-all duration-200 text-xs font-medium border border-outline-variant/20"
          >
            <span>{effortLabels[effort]}</span>
            <ChevronDown
              size={11}
              className={`transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
            />
          </button>
        )}
      </div>

      {/* Dropdown — opens upward since it's above the input */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.95 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute left-0 bottom-full mb-2 w-36 glass-panel border border-outline-variant/20 rounded-xl shadow-2xl overflow-hidden z-[100]"
          >
            <div className="py-1">
              {efforts.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => {
                    onEffortChange(e);
                    setIsOpen(false);
                  }}
                  className="w-full flex items-center justify-between px-4 py-2 text-xs hover:bg-primary/10 transition-colors"
                >
                  <span className={effort === e ? 'text-amber-400 font-medium' : 'text-on-surface'}>
                    {effortLabels[e]}
                  </span>
                  {effort === e && <Check size={13} className="text-amber-400" />}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
