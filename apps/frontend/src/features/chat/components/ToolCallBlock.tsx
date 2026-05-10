import {
  Wrench,
  CheckCircle,
  AlertCircle,
  ChevronDown,
  FolderOpen,
  FileText,
  ImagePlus,
  Clock,
  ArrowRight,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';

interface ToolCallBlockProps {
  name: string;
  args: Record<string, unknown>;
  result?: string | null;
  isError?: boolean;
  isPending?: boolean;
}

/**
 * Renders a per-tool icon based on the tool name.
 * Falls back to the generic Wrench icon for unknown tools.
 */
function ToolIcon({ toolName, className }: { toolName: string; className?: string }) {
  const size = 11;
  switch (toolName) {
    case 'list_directory':
      return <FolderOpen size={size} className={className} />;
    case 'read_file':
      return <FileText size={size} className={className} />;
    case 'generate_image':
      return <ImagePlus size={size} className={className} />;
    case 'get_current_datetime':
      return <Clock size={size} className={className} />;
    default:
      return <Wrench size={size} className={className} />;
  }
}

/**
 * Abbreviates a path for inline display next to the tool label.
 * Replaces the home directory prefix with `~` and keeps it short.
 */
function abbreviatePath(rawPath: unknown): string | null {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) return null;
  let p = rawPath.trim();
  const homeMatch = p.match(/^\/home\/[^/]+/);
  if (homeMatch) p = '~' + p.slice(homeMatch[0].length);
  return p;
}

/**
 * Produces an optional inline hint string that follows the label.
 * For filesystem tools the path is shown; for others nothing is shown.
 */
function getToolHint(toolName: string, args: Record<string, unknown>): string | null {
  switch (toolName) {
    case 'list_directory':
    case 'read_file':
      return abbreviatePath(args.path);
    default:
      return null;
  }
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
