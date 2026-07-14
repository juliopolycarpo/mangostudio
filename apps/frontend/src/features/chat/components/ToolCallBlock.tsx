import {
  inferToolExecutionSource,
  isActiveToolExecutionStatus,
  type ToolExecutionSnapshot,
  type ToolExecutionStatus,
} from '@mangostudio/shared/tool-executions';
import {
  AlertCircle,
  ArrowRight,
  Ban,
  Check,
  CheckCircle,
  ChevronDown,
  Copy,
  TimerOff,
  UserRound,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { getToolHint, ToolIcon } from './ToolCallVisuals';

const COPIED_RESET_MS = 2000;

interface ToolCallBlockProps {
  name: string;
  args: Record<string, unknown>;
  result?: string | null;
  status: ToolExecutionStatus;
  execution?: ToolExecutionSnapshot;
}

/** Chip tone per lifecycle status; active states pulse the tool icon instead. */
function statusTone(status: ToolExecutionStatus): string {
  switch (status) {
    case 'failed':
    case 'timed_out':
      return 'border-error/30 text-error';
    case 'cancelled':
      return 'border-outline-variant/30 text-on-surface-variant';
    case 'succeeded':
      return 'border-success/25 text-success';
    default:
      return 'border-primary/30 text-primary';
  }
}

function StatusIcon({ status, name }: { status: ToolExecutionStatus; name: string }) {
  switch (status) {
    case 'succeeded':
      return <CheckCircle size={11} className="shrink-0" />;
    case 'failed':
      return <AlertCircle size={11} className="shrink-0" />;
    case 'timed_out':
      return <TimerOff size={11} className="shrink-0" />;
    case 'cancelled':
      return <Ban size={11} className="shrink-0" />;
    case 'awaiting_user':
      return <UserRound size={11} className="shrink-0" />;
    default:
      return <ToolIcon toolName={name} className="animate-pulse shrink-0" />;
  }
}

/** Formats a monotonic duration for the chip, e.g. `640ms` or `2.4s`. */
export function formatToolDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

export function ToolCallBlock({ name, args, result, status, execution }: ToolCallBlockProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const labels = t.tools.labels as Record<string, string> | undefined;
  const label = labels?.[name] ?? name;
  const hint = getToolHint(name, args);
  const isError = status === 'failed' || status === 'timed_out';
  const source = execution?.source ?? inferToolExecutionSource(name);
  // Non-nominal outcomes and the awaiting state are called out explicitly;
  // success/progress already read from the icon and tone.
  const statusLabel =
    status === 'succeeded' || status === 'queued' || status === 'running'
      ? null
      : t.tools.status[status];
  const duration = execution?.durationMs;

  let parsedResult: unknown = null;
  if (result) {
    try {
      parsedResult = JSON.parse(result);
    } catch {
      parsedResult = result;
    }
  }

  const handleCopyResult = async () => {
    if (!result) return;
    const text =
      typeof parsedResult === 'string' ? parsedResult : JSON.stringify(parsedResult, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } catch {
      // Clipboard API unavailable (e.g. insecure context); copy is best-effort.
    }
  };

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`glass-surface flex items-center gap-2 text-xs py-1.5 px-3 rounded-full w-fit max-w-full border
                   transition-all duration-200 cursor-pointer ${statusTone(status)}`}
      >
        <StatusIcon status={status} name={name} />
        <span className="tracking-wide shrink-0">{label}</span>
        {source !== 'builtin' && (
          <span className="rounded-full bg-surface-container-high px-1.5 py-0.5 text-[10px] text-on-surface-variant/70 shrink-0">
            {t.tools.sources[source]}
          </span>
        )}
        {hint && (
          <>
            <ArrowRight size={9} className="text-on-surface-variant/40 shrink-0" />
            <span className="font-mono text-on-surface-variant/60 truncate max-w-[160px] sm:max-w-[260px] md:max-w-[380px]">
              {hint}
            </span>
          </>
        )}
        {statusLabel && <span className="shrink-0 opacity-80">{statusLabel}</span>}
        {duration !== undefined && !isActiveToolExecutionStatus(status) && (
          <span className="font-mono text-on-surface-variant/50 text-[10px] shrink-0">
            {formatToolDuration(duration)}
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
                  <div className="flex items-center justify-between mb-1">
                    <p
                      className={`uppercase tracking-wider text-[10px] ${isError ? 'text-error/50' : 'text-on-surface-variant/50'}`}
                    >
                      {isError ? t.tools.errorLabel : t.tools.resultLabel}
                    </p>
                    <button
                      type="button"
                      onClick={() => void handleCopyResult()}
                      title={copied ? t.tools.resultCopied : t.tools.copyResult}
                      className="opacity-60 hover:opacity-100 transition-opacity duration-200 text-on-surface-variant cursor-pointer"
                    >
                      {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                    </button>
                  </div>
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
