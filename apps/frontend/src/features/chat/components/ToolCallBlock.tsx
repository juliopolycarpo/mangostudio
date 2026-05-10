import { Wrench, CheckCircle, AlertCircle, ChevronDown } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';

interface ToolCallBlockProps {
  name: string;
  args: Record<string, unknown>;
  result?: string | null;
  isError?: boolean;
  isPending?: boolean;
}

export function ToolCallBlock({ name, args, result, isError, isPending }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);

  let parsedResult: unknown = null;
  if (result) {
    try {
      parsedResult = JSON.parse(result);
    } catch {
      parsedResult = result;
    }
  }

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`glass-surface flex items-center gap-2 text-xs py-1.5 px-3 rounded-full w-fit border
                   transition-all duration-200 cursor-pointer ${
                     isError
                       ? 'border-error/30 text-error'
                       : isPending
                         ? 'border-primary/30 text-primary'
                         : 'border-success/25 text-success'
                   }`}
      >
        {isPending ? (
          <Wrench size={11} className="animate-pulse" />
        ) : isError ? (
          <AlertCircle size={11} />
        ) : (
          <CheckCircle size={11} />
        )}
        <span className="font-mono tracking-wide">{name}()</span>
        <ChevronDown
          size={11}
          className={`transition-transform duration-300 opacity-50 ${expanded ? 'rotate-180' : ''}`}
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
            <div className="p-4 space-y-3 text-xs font-mono">
              {Object.keys(args).length > 0 && (
                <div>
                  <p className="text-on-surface-variant/50 uppercase tracking-wider text-[10px] mb-1">
                    args
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
                    {isError ? 'error' : 'result'}
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
