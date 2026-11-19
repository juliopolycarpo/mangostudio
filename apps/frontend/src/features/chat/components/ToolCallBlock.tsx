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
import { useNow } from '@/hooks/use-now';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

import { buildFileChangePreview, isFileChangeTool } from './file-change-preview';
import { FileChangePreviewBody } from './FileChangePreview';
import { TimelineDisclosure } from './TimelineDisclosure';
import { TimelineItem } from './TimelineItem';
import { TimelineRow } from './TimelineRow';
import {
  formatToolSummary,
  getShellStreams,
  parseToolResult,
  summarizeParsedToolResult,
} from './tool-result-summary';
import { ToolCallRetryControl } from './ToolCallRetryControl';
import {
  formatToolDuration,
  formatToolElapsed,
  formatToolLimit,
  getToolHint,
  StatusGlyph,
  toneTextClass,
  toolStatusTone,
} from './ToolCallVisuals';

/** How often a running call's clock repaints: its readout is whole seconds. */
const LIVE_ELAPSED_TICK_MS = 1_000;

interface ToolCallBlockProps {
  /** The call's id; with it the card can offer Retry inside a `ToolCallRetryProvider`. */
  toolCallId?: string;
  /** The reader, not the model, asked for this call (a retry). */
  initiatedByUser?: boolean;
  name: string;
  args: Record<string, unknown>;
  result?: string | null;
  status: ToolExecutionStatus;
  execution?: ToolExecutionSnapshot;
  /** True when this call is the message's most recent file mutation. */
  isLatestFileChange?: boolean;
  /**
   * True while the turn that owns this call is still streaming. A failure opens
   * its card only then (or on the call's own running -> failed transition), so
   * a reopened chat does not replay every historical failure as an open body.
   */
  isLiveTurn?: boolean;
}

export function ToolCallBlock({
  toolCallId,
  initiatedByUser = false,
  name,
  args,
  result,
  status,
  execution,
  isLatestFileChange = false,
  isLiveTurn = false,
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

  const [expanded, setExpanded] = useState((isError && isLiveTurn) || autoExpandPreview);
  const [showRaw, setShowRaw] = useState(false);

  // The model's remediation advice sits in a failed call's body, so a failure
  // that happens in front of the reader opens the card: either this call went
  // from active to failed while mounted, or it first appeared failed inside the
  // streaming turn. Adjusted during render (React's "derive state from props"
  // pattern) so the card opens in the same commit as the status, with no effect
  // pass; the reader can still toggle it by hand afterwards.
  const [seenStatus, setSeenStatus] = useState(status);
  if (seenStatus !== status) {
    setSeenStatus(status);
    if (isError && isActiveToolExecutionStatus(seenStatus)) setExpanded(true);
  }

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
  // Why a failed, cancelled or timed-out call ended. "Timed out" beside "Time
  // limit reached" would say the same thing twice, so that pair shows only the
  // status.
  const reasonCode = execution?.reasonCode;
  const reasonLabel =
    reasonCode !== undefined &&
    (status === 'failed' || status === 'cancelled' || status === 'timed_out') &&
    !(status === 'timed_out' && reasonCode === 'timeout')
      ? t.tools.reasons[reasonCode]
      : null;
  // The limit a timed-out call hit, read from the snapshot the call started
  // under: the tool setting may have changed since, and an MCP call's limit is
  // its server's, which no tool setting records.
  const limitLabel =
    status === 'timed_out' && execution?.timeoutMs !== undefined
      ? formatMessage(t.tools.timeLimit, { limit: formatToolLimit(execution.timeoutMs) })
      : null;
  const statusDetail = [reasonLabel, limitLabel].filter(Boolean).join(' · ');
  const resultLabels: Record<ResultKind, string> = {
    error: t.tools.errorLabel,
    result: t.tools.resultLabel,
    stderr: t.tools.stderrLabel,
    stdout: t.tools.stdoutLabel,
  };
  const isActive = isActiveToolExecutionStatus(status);
  const duration = execution?.durationMs;
  // A running call counts up beside the limit it started under. The clock only
  // runs while the call does: a call waiting on the reader or queued is not
  // spending its budget, and a settled call shows its measured duration.
  const isRunning = status === 'running';
  const now = useNow(isRunning ? LIVE_ELAPSED_TICK_MS : null);
  // The hub's start time is the anchor; a legacy part with no snapshot counts
  // from when this card first saw the call running.
  const [firstSeenRunningAt] = useState(() => Date.now());
  const liveElapsed = isRunning
    ? formatToolElapsed(now - (execution?.startedAt ?? firstSeenRunningAt))
    : null;
  const liveClock =
    liveElapsed !== null && execution?.timeoutMs !== undefined
      ? formatMessage(t.tools.elapsedOfLimit, {
          elapsed: liveElapsed,
          limit: formatToolLimit(execution.timeoutMs),
        })
      : liveElapsed;
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
    () => (expanded ? formatToolResult(name, parsedResult, isError) : null),
    [expanded, name, parsedResult, isError]
  );

  const rawToggle = (
    <Button variant="subtle" size="sm" onClick={() => setShowRaw((v) => !v)}>
      {showRaw ? t.tools.diff.hideRaw : t.tools.diff.showRaw}
    </Button>
  );

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

  return (
    <TimelineItem tone={tone}>
      <TimelineRow
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        glyph={<StatusGlyph status={status} name={name} />}
        summary={summary ? formatToolSummary(summary, t.tools.summary) : null}
        duration={
          liveClock ?? (duration !== undefined && !isActive ? formatToolDuration(duration) : null)
        }
      >
        <span className={cn('shrink-0 font-mono font-medium', toneTextClass(tone))}>{label}</span>
        {source !== 'builtin' && <Badge>{t.tools.sources[source]}</Badge>}
        {initiatedByUser && <Badge>{t.tools.retry.byYou}</Badge>}
        {hint && <span className="truncate font-mono text-fg-muted">{hint}</span>}
        {statusLabel && (
          <span className={cn('shrink-0', toneTextClass(tone))}>
            {statusLabel}
            {statusDetail && <span className="text-fg-subtle"> · {statusDetail}</span>}
          </span>
        )}
      </TimelineRow>

      {/* Outside the row: the row is a button, and a button cannot hold one. */}
      {toolCallId !== undefined && (
        <div className="flex pl-6">
          <ToolCallRetryControl
            toolCallId={toolCallId}
            name={name}
            args={args}
            status={status}
            execution={execution}
            isLiveTurn={isLiveTurn}
          />
        </div>
      )}

      <TimelineDisclosure open={expanded}>
        <div className="app-scrollbar max-h-48 overflow-y-auto text-xs sm:max-h-72 md:max-h-96">
          {/* The toggle rides in the first file's header while the diff shows
              (one band, not a bare button above a second one). The raw view has
              no file header to carry it, so it keeps a row of its own. The diff
              is drawn in the same sections as the output below: a 32px header,
              then its lines as a full-bleed band of canvas. */}
          {preview !== null && showRaw && (
            <div className="flex h-8 items-center justify-end pr-1.5">{rawToggle}</div>
          )}
          {preview !== null && !showRaw && (
            <FileChangePreviewBody preview={preview} action={rawToggle} />
          )}
          {(preview === null || showRaw) && Object.keys(args).length > 0 && (
            <ToolOutputSection label={t.tools.argsLabel}>
              <pre className="whitespace-pre-wrap font-mono leading-relaxed text-fg-muted">
                {JSON.stringify(args, null, 2)}
              </pre>
            </ToolOutputSection>
          )}
          {(preview === null || showRaw) &&
            displayedResult?.sections.map((section) => (
              <ToolOutputSection
                key={section.kind}
                label={resultLabels[section.kind]}
                danger={section.danger}
                action={
                  <CopyOutputButton
                    text={section.text}
                    label={
                      section.kind === 'stdout' || section.kind === 'stderr'
                        ? formatMessage(t.tools.copyStream, { stream: resultLabels[section.kind] })
                        : t.tools.copyResult
                    }
                  />
                }
              >
                {/* A failure's text is what the reader came for, so it keeps the
                    primary colour; the label above and the row's glyph carry the
                    tone. */}
                <pre
                  className={cn(
                    'whitespace-pre-wrap break-words font-mono leading-relaxed',
                    section.danger ? 'text-fg' : 'text-fg-muted'
                  )}
                >
                  {section.text}
                </pre>
              </ToolOutputSection>
            ))}
          {(preview === null || showRaw) && displayedResult?.truncated && (
            <p className="border-t border-stroke px-3 py-2 text-fg-subtle">
              {t.tools.outputTruncated}
            </p>
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

type ResultKind = 'error' | 'result' | 'stderr' | 'stdout';

interface ResultSection {
  readonly kind: ResultKind;
  readonly text: string;
  /** The section is the failure itself: its label is read in the error colour. */
  readonly danger: boolean;
}

interface FormattedToolResult {
  readonly sections: readonly ResultSection[];
  /** The runtime cut a shell run's output at its size limit. */
  readonly truncated: boolean;
}

/**
 * What the disclosed body shows for a finished call, as the sections it is
 * drawn in.
 *
 * A shell run is its two streams, one section each and real line breaks, with
 * the quiet one dropped: a compiler's complaint is the point of a failed `bash`
 * row, and `JSON.stringify` turned it into one wrapped paragraph of `\n` and
 * `\"`. Everything else is a single section, as before.
 */
function formatToolResult(
  name: string,
  parsedResult: unknown,
  isError: boolean
): FormattedToolResult | null {
  if (parsedResult === null) return null;

  const streams = getShellStreams(name, parsedResult);
  if (streams) {
    // What the reader came for first: stderr when the call failed, stdout when
    // it did not. `exitCode` is not repeated here; the row already says it.
    const ordered: ResultSection[] = [
      { kind: 'stdout', text: streams.stdout, danger: false },
      { kind: 'stderr', text: streams.stderr, danger: isError },
    ];
    if (isError) ordered.reverse();
    const sections = ordered.filter((section) => section.text.length > 0);
    // A run that printed nothing has no stream to show, so its payload is the
    // only thing left to say what happened.
    if (sections.length > 0) return { sections, truncated: streams.truncated };
  }

  const kind = isError ? 'error' : 'result';
  if (
    isError &&
    typeof parsedResult === 'object' &&
    'error' in parsedResult &&
    typeof parsedResult.error === 'string'
  ) {
    return { sections: [{ kind, text: parsedResult.error, danger: true }], truncated: false };
  }
  const text =
    typeof parsedResult === 'string' ? parsedResult : JSON.stringify(parsedResult, null, 2);
  return { sections: [{ kind, text, danger: isError }], truncated: false };
}

/**
 * Copies one section's text, which is the text the section shows.
 *
 * Its own component because each section has its own "copied" tick: a shell run
 * has two, and ticking one must not tick the other.
 */
function CopyOutputButton({ text, label }: { text: string; label: string }) {
  const { t } = useI18n();
  const { copy, copied } = useClipboard();
  return (
    <Button
      variant="subtle"
      size="sm"
      onClick={() => void copy(text)}
      title={copied ? t.tools.resultCopied : label}
      className="size-7 px-0 text-fg-muted"
    >
      {copied ? <Check size={ICON_SM} className="text-success" /> : <Copy size={ICON_SM} />}
    </Button>
  );
}
