import {
  inferToolExecutionSource,
  isActiveToolExecutionStatus,
  type ToolExecutionSnapshot,
  type ToolExecutionStatus,
} from '@mangostudio/shared/tool-executions';
import { Check, Copy } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { useChatDisplaySettings } from '@/hooks/use-chat-display-settings';
import { useClipboard } from '@/hooks/use-clipboard';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';
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
        <span className={cn('shrink-0 font-mono font-medium', toneTextClass(tone))}>{label}</span>
        {source !== 'builtin' && <Badge>{t.tools.sources[source]}</Badge>}
        {hint && <span className="truncate font-mono text-fg-muted">{hint}</span>}
        {statusLabel && <span className={cn('shrink-0', toneTextClass(tone))}>{statusLabel}</span>}
      </TimelineRow>

      <TimelineDisclosure open={expanded}>
        <div className="app-scrollbar max-h-48 overflow-y-auto text-xs sm:max-h-72 md:max-h-96">
          {preview !== null && (
            <div className="flex h-8 items-center justify-end pr-1.5">
              <Button variant="subtle" size="sm" onClick={() => setShowRaw((v) => !v)}>
                {showRaw ? t.tools.diff.hideRaw : t.tools.diff.showRaw}
              </Button>
            </div>
          )}
          {preview !== null && !showRaw && (
            <div className="border-t border-stroke bg-canvas p-3">
              <FileChangePreviewBody preview={preview} />
            </div>
          )}
          {(preview === null || showRaw) && Object.keys(args).length > 0 && (
            <ToolOutputSection label={t.tools.argsLabel}>
              <pre className="whitespace-pre-wrap font-mono leading-relaxed text-fg-muted">
                {JSON.stringify(args, null, 2)}
              </pre>
            </ToolOutputSection>
          )}
          {(preview === null || showRaw) && displayedResult !== null && (
            <ToolOutputSection
              label={isError ? t.tools.errorLabel : t.tools.resultLabel}
              danger={isError}
              action={
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={() => void handleCopyResult()}
                  title={copied ? t.tools.resultCopied : t.tools.copyResult}
                  className="size-7 px-0 text-fg-muted"
                >
                  {copied ? (
                    <Check size={ICON_SM} className="text-success" />
                  ) : (
                    <Copy size={ICON_SM} />
                  )}
                </Button>
              }
            >
              <pre
                className={cn(
                  'whitespace-pre-wrap font-mono leading-relaxed',
                  isError ? 'text-danger' : 'text-fg-muted'
                )}
              >
                {displayedResult}
              </pre>
            </ToolOutputSection>
          )}
        </div>
      </TimelineDisclosure>
    </TimelineItem>
  );
}

interface ToolOutputSectionProps {
  label: string;
  /** The section reports a failure: its label is read in the error colour. */
  danger?: boolean;
  action?: ReactNode;
  children: ReactNode;
}

/**
 * One labelled stretch of a tool's disclosed body: a 32px header on the card,
 * then the output in mono on `canvas`. Sections divide with a hairline rather
 * than nesting a card in the card.
 */
function ToolOutputSection({ label, danger = false, action, children }: ToolOutputSectionProps) {
  return (
    <div className="border-t border-stroke first:border-t-0">
      <div className="flex h-8 items-center justify-between pr-1.5 pl-3">
        <MicroLabel className={cn(danger && 'text-danger')}>{label}</MicroLabel>
        {action}
      </div>
      <div className="bg-canvas p-3">{children}</div>
    </div>
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
