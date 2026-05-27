import { AlertCircle, ArrowRight, CheckCircle, ChevronDown } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { ToolCallBlock } from './ToolCallBlock';
import { getToolHint, ToolIcon } from './ToolCallVisuals';
import type { ToolCallEntry } from './tool-call-grouping';

interface ToolCallGroupBlockProps {
  calls: ToolCallEntry[];
}

/**
 * Collapses a run of same-name tool calls into one summary pill that expands
 * into the individual calls. Expects two or more entries sharing a tool name.
 *
 * // Usage: <ToolCallGroupBlock calls={entries} />
 */
export function ToolCallGroupBlock({ calls }: ToolCallGroupBlockProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  const name = calls[0].name;
  const labels = t.tools.labels as Record<string, string> | undefined;
  const label = labels?.[name] ?? name;
  const firstHint = getToolHint(name, calls[0].args);
  const moreCount = calls.length - 1;
  const moreLabel = t.tools.moreCount.replace('{count}', String(moreCount));

  const anyPending = calls.some((c) => c.isPending);
  const anyError = calls.some((c) => c.isError);
  const tone = anyError
    ? 'border-error/30 text-error'
    : anyPending
      ? 'border-primary/30 text-primary'
      : 'border-success/25 text-success';

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`glass-surface flex items-center gap-2 text-xs py-1.5 px-3 rounded-full w-fit max-w-full border
                   transition-all duration-200 cursor-pointer ${tone}`}
      >
        {anyPending ? (
          <ToolIcon toolName={name} className="animate-pulse shrink-0" />
        ) : anyError ? (
          <AlertCircle size={11} className="shrink-0" />
        ) : (
          <CheckCircle size={11} className="shrink-0" />
        )}
        <span className="tracking-wide shrink-0">{label}</span>
        {firstHint && (
          <>
            <ArrowRight size={9} className="text-on-surface-variant/40 shrink-0" />
            <span className="font-mono text-on-surface-variant/60 truncate max-w-[120px] sm:max-w-[200px] md:max-w-[300px]">
              {firstHint}
            </span>
          </>
        )}
        {moreCount > 0 && (
          <span className="rounded-full bg-surface-container-high px-1.5 py-0.5 text-[10px] text-on-surface-variant/70 shrink-0">
            {moreLabel}
          </span>
        )}
        <ChevronDown
          size={11}
          className={`transition-transform duration-300 opacity-50 shrink-0 ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="group-body"
            initial={{ opacity: 0, height: 0, y: -4 }}
            animate={{ opacity: 1, height: 'auto', y: 0 }}
            exit={{ opacity: 0, height: 0, y: -6 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="mt-1.5 ml-2 border-l border-outline-variant/15 pl-3"
          >
            {calls.map((call) => (
              <ToolCallBlock
                key={call.toolCallId}
                name={call.name}
                args={call.args}
                result={call.result}
                isError={call.isError}
                isPending={call.isPending}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
