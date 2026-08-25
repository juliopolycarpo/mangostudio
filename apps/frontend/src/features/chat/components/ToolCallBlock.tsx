import {
  inferToolExecutionSource,
  isActiveToolExecutionStatus,
  type ToolExecutionSnapshot,
  type ToolExecutionStatus,
} from '@mangostudio/shared/tool-executions';
import { Check, Copy } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useChatDisplaySettings } from '@/hooks/use-chat-display-settings';
import { useClipboard } from '@/hooks/use-clipboard';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { FileChangePreviewBody } from './FileChangePreview';
import { buildFileChangePreview, isFileChangeTool } from './file-change-preview';
import { TimelineDisclosure } from './TimelineDisclosure';
import { TimelineItem } from './TimelineItem';
import { TimelineRow } from './TimelineRow';
import {
  formatToolDuration,
  getToolHint,
  StatusGlyph,
  toneTextClass,
  toolStatusTone,
} from './ToolCallVisuals';
import {
  formatToolSummary,
  parseToolResult,
  summarizeParsedToolResult,
} from './tool-result-summary';

interface ToolCallBlockProps {
  name: string;
  args: Record<string, unknown>;
  result?: string | null;
  status: ToolExecutionStatus;
  execution?: ToolExecutionSnapshot;
  /** True when this call is the message's most recent file mutation. */
  isLatestFileChange?: boolean;
}

export function ToolCallBlock({
  name,
  args,
  result,
  status,
  execution,
  isLatestFileChange = false,
}: ToolCallBlockProps) {
  const { t } = useI18n();
  const { diffPreviewsEnabled, diffPreviewMode } = useChatDisplaySettings();
  const isError = status === 'failed' || status === 'timed_out';

  // Previewability is decided from the tool name alone so the expansion policy
  // does not depend on arguments that are still streaming in, and so the diff
  // itself is only computed for a card the reader can actually see.
  const previewable = diffPreviewsEnabled && !isError && isFileChangeTool(name);
  const autoExpandPreview =
    previewable &&
    (diffPreviewMode === 'expanded' ||
      (diffPreviewMode === 'collapse_older' && isLatestFileChange));

  const [expanded, setExpanded] = useState(isError || autoExpandPreview);
  const [showRaw, setShowRaw] = useState(false);
  const { copy, copied } = useClipboard();

  const preview = useMemo(
    () => (previewable && expanded ? buildFileChangePreview(name, args, result) : null),
    [previewable, expanded, name, args, result]
  );

  const labels = t.tools.labels as Record<string, string> | undefined;
  const label = labels?.[name] ?? name;
  const hint = getToolHint(name, args, (count) =>
    formatMessage(t.tools.moreCount, { count: String(count) })
  );
  const source = execution?.source ?? inferToolExecutionSource(name);
  // Non-nominal outcomes and the awaiting state are called out explicitly;
  // success/progress already read from the tone and the node dot.
  const statusLabel =
    status === 'succeeded' || status === 'queued' || status === 'running'
      ? null
      : t.tools.status[status];
  const tone = toolStatusTone(status);
  const isActive = isActiveToolExecutionStatus(status);
  const duration = execution?.durationMs;
  // Parsed once and shared: the outcome on the row and the raw body below it
  // read the same payload, and a result is the largest string in a transcript.
  const parsedResult = useMemo(() => parseToolResult(result), [result]);
  const summary = useMemo(
    () => (isActive ? null : summarizeParsedToolResult(name, parsedResult, args)),
    [isActive, name, parsedResult, args]
  );
  // Only the disclosed body reads this, and re-serializing an unopened result
  // on every stream frame is work nobody can see.
  const displayedResult = useMemo(
    () => (expanded ? formatToolResult(parsedResult, isError) : null),
    [expanded, parsedResult, isError]
  );

  useEffect(() => {
    if (isError) setExpanded(true);
  }, [isError]);

  // Applies the display mode once a card turns previewable — a call mounts with
  // empty arguments while it streams, so the mount-time state is not enough. In
  // collapse_older a newly arriving mutation collapses the previously latest
  // card and expands the new one; either can still be toggled by hand.
  useEffect(() => {
    if (!previewable) return;
    if (diffPreviewMode === 'expanded') {
      setExpanded(true);
      return;
    }
    if (diffPreviewMode === 'collapse_older') setExpanded(isError || isLatestFileChange);
  }, [previewable, diffPreviewMode, isError, isLatestFileChange]);

  const handleCopyResult = async () => {
    if (!displayedResult) return;
    await copy(displayedResult);
  };

  return (
    <TimelineItem tone={tone}>
      <TimelineRow
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        glyph={<StatusGlyph status={status} name={name} />}
        summary={summary ? formatToolSummary(summary, t.tools.summary) : null}
        duration={duration !== undefined && !isActive ? formatToolDuration(duration) : null}
      >
        <span className={`shrink-0 font-mono font-semibold ${toneTextClass(tone)}`}>{label}</span>
        {source !== 'builtin' && (
          <span className="shrink-0 rounded-sm bg-surface-container-high px-1 py-px text-[10px] text-on-surface-variant/70">
            {t.tools.sources[source]}
          </span>
        )}
        {hint && <span className="truncate font-mono text-on-surface-variant/60">{hint}</span>}
        {statusLabel && (
          <span className={`shrink-0 text-[11px] ${toneTextClass(tone)}`}>{statusLabel}</span>
        )}
      </TimelineRow>

      <TimelineDisclosure open={expanded}>
        <div className="app-scrollbar max-h-48 space-y-3 overflow-y-auto p-3.5 font-mono text-xs sm:max-h-72 md:max-h-96">
          {preview !== null && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setShowRaw((v) => !v)}
                className="cursor-pointer text-[10px] uppercase tracking-wider text-on-surface-variant/50 transition-colors duration-200 hover:text-on-surface-variant"
              >
                {showRaw ? t.tools.diff.hideRaw : t.tools.diff.showRaw}
              </button>
            </div>
          )}
          {preview !== null && !showRaw && <FileChangePreviewBody preview={preview} />}
          {(preview === null || showRaw) && Object.keys(args).length > 0 && (
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-on-surface-variant/50">
                {t.tools.argsLabel}
              </p>
              <pre className="whitespace-pre-wrap leading-relaxed text-on-surface-variant/70">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          {(preview === null || showRaw) && displayedResult !== null && (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <p
                  className={`text-[10px] uppercase tracking-wider ${isError ? 'text-error/50' : 'text-on-surface-variant/50'}`}
                >
                  {isError ? t.tools.errorLabel : t.tools.resultLabel}
                </p>
                <button
                  type="button"
                  onClick={() => void handleCopyResult()}
                  title={copied ? t.tools.resultCopied : t.tools.copyResult}
                  className="cursor-pointer text-on-surface-variant opacity-60 transition-opacity duration-200 hover:opacity-100"
                >
                  {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                </button>
              </div>
              <pre
                className={`whitespace-pre-wrap leading-relaxed ${isError ? 'text-error/80' : 'text-on-surface-variant/70'}`}
              >
                {displayedResult}
              </pre>
            </div>
          )}
        </div>
      </TimelineDisclosure>
    </TimelineItem>
  );
}

function formatToolResult(parsedResult: unknown, isError: boolean): string | null {
  if (parsedResult === null) return null;
  if (
    isError &&
    typeof parsedResult === 'object' &&
    'error' in parsedResult &&
    typeof parsedResult.error === 'string'
  ) {
    return parsedResult.error;
  }
  return typeof parsedResult === 'string'
    ? parsedResult
    : (JSON.stringify(parsedResult, null, 2) ?? null);
}
