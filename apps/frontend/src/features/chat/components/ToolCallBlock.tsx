import { AlertCircle, ArrowRight, CheckCircle, ChevronDown } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { getToolHint, ToolIcon } from './ToolCallVisuals';

interface ToolCallBlockProps {
  name: string;
  args: Record<string, unknown>;
  result?: string | null;
  isError?: boolean;
  isPending?: boolean;
}

export function ToolCallBlock({ name, args, result, isError, isPending }: ToolCallBlockProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  const labels = t.tools.labels as Record<string, string> | undefined;
  const label = labels?.[name] ?? name;
  const hint = getToolHint(name, args);

  let parsedResult: unknown = null;
  if (result) {
    try {
      parsedResult = JSON.parse(result);
    } catch {
      parsedResult = result;
    }
  }

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`glass-surface flex items-center gap-2 text-xs py-1.5 px-3 rounded-full w-fit max-w-full border
                   transition-all duration-200 cursor-pointer ${
                     isError
                       ? 'border-error/30 text-error'
                       : isPending
                         ? 'border-primary/30 text-primary'
                         : 'border-success/25 text-success'
}`}
      >
        {isPending ? (
          <ToolIcon toolName={name} className="animate-pulse shrink-0" />
        ) : isError ? (
          <AlertCircle size={11} className="shrink-0" />
        ) : (
          <CheckCircle size={11} className="shrink-0" />
        )}
        <span className="tracking-wide shrink-0">{label}</span>
        {hint && (
          <>
            <ArrowRight size={9} className="text-on-surface-variant/40 shrink-0" />
            <span className="font-mono text-on-surface-variant/60 truncate max-w-[160px] sm:max-w-[260px] md:max-w-[380px]">
              {hint}
            </span>
          </>
        )}
        <ChevronDown
          size={11}
          className={`transition-transform duration-300 opacity-50 shrink-0 ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="tool-body"
            initial={{ opacity: 0, height: 0, y: -4 }}
            animate={{ opacity: 1, height: 'auto', y: 0 }}
            exit={{ opacity: 0, height: 0, y: -6 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="glass-surface-subtle mt-1.5 rounded-xl border border-outline-variant/15 overflow-hidden"
          >
            <div className="p-4 space-y-3 text-xs font-mono max-h-48 sm:max-h-72 md:max-h-96 overflow-y-auto app-scrollbar">
              {Object.keys(args).length > 0 && (
                <div>
                  <p className="text-on-surface-variant/50 uppercase tracking-wider text-[10px] mb-1">
                    {t.tools.argsLabel}
                  </p>
                  <pre className="text-on-surface-variant/70 whitespace-pre-wrap leading-relaxed">
                    {JSON.stringify(args, null, 2)}
                  </pre>
                </div>
              )}
              {parsedResult !== null && (
                <div>
                  <p
                    className={`uppercase tracking-wider text-[10px] mb-1 ${isError ? 'text-error/50' : 'text-on-surface-variant/50'}`}
                  >
                    {isError ? t.tools.errorLabel : t.tools.resultLabel}
                  </p>
                  <pre
                    className={`whitespace-pre-wrap leading-relaxed ${isError ? 'text-error/80' : 'text-on-surface-variant/70'}`}
                  >
                    {typeof parsedResult === 'string'
                      ? parsedResult
                      : JSON.stringify(parsedResult, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
