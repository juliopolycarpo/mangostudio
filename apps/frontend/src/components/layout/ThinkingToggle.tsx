import type { ReasoningEffort } from '@mangostudio/shared';
import { Brain, Check, ChevronDown } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';

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
    xhigh: t.thinking.effortHigh,
    max: t.thinking.effortHigh,
  };

  return (
    <div className="relative flex items-center" ref={ref}>
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => onToggle(!enabled)}
          aria-pressed={enabled}
          className={`composer-chip ${enabled ? 'border-primary/30 bg-primary/10 text-primary' : ''}`}
        >
          <Brain size={12} className="shrink-0" />
          <span>{t.thinking.enable}</span>
        </button>

        {/* Effort selector — only visible when reasoning is on */}
        {enabled && (
          <button
            type="button"
            onClick={() => setIsOpen(!isOpen)}
            aria-haspopup="listbox"
            aria-expanded={isOpen}
            className="composer-chip"
          >
            <span className="composer-chip-value">{effortLabels[effort]}</span>
            <ChevronDown
              size={11}
              className={`shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
            />
          </button>
        )}
      </div>

      {/* Upward: the composer sits at the foot of the viewport, so the panel
          this used to open downward landed off the bottom of the screen. */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.95 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="dropdown-panel absolute left-0 bottom-full mb-2 w-40"
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
                  className="w-full flex items-center justify-between px-4 py-2 text-sm hover:bg-primary/10 transition-colors group/item"
                >
                  <span
                    className={
                      effort === e
                        ? 'text-primary font-medium'
                        : 'text-on-surface group-hover/item:text-primary/90'
                    }
                  >
                    {effortLabels[e]}
                  </span>
                  {effort === e && <Check size={14} className="text-primary" />}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
