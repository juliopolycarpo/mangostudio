import type { ChatDisplaySettings } from '@mangostudio/shared/app-settings';
import {
  isActiveToolExecutionStatus,
  type ToolExecutionStatus,
} from '@mangostudio/shared/tool-executions';
import { useEffect, useMemo, useState } from 'react';
import { useChatDisplaySettings } from '@/hooks/use-chat-display-settings';
import { useI18n } from '@/hooks/use-i18n';
import { isFileChangeTool } from './file-change-preview';
import { TimelineDisclosure } from './TimelineDisclosure';
import { TimelineItem } from './TimelineItem';
import { TimelineRow } from './TimelineRow';
import { ToolCallBlock } from './ToolCallBlock';
import {
  formatToolDuration,
  getToolHint,
  StatusGlyph,
  toneTextClass,
  toolStatusTone,
} from './ToolCallVisuals';
import type { ToolCallEntry } from './tool-call-grouping';
import { formatToolSummary, getToolGroupSummary } from './tool-result-summary';

interface ToolCallGroupBlockProps {
  calls: ToolCallEntry[];
  /** toolCallId of the message's most recent file mutation, if any. */
  latestFileChangeId?: string | null;
}

/**
 * The lifecycle of a run as a whole: the worst outcome any member reached, so
 * a collapsed group can never hide a failure behind its neighbours' successes.
 */
function groupStatus(calls: ToolCallEntry[]): ToolExecutionStatus {
  if (calls.some((call) => call.status === 'failed' || call.status === 'timed_out'))
    return 'failed';
  if (calls.some((call) => isActiveToolExecutionStatus(call.status))) return 'running';
  if (calls.some((call) => call.status === 'cancelled')) return 'cancelled';
  return 'succeeded';
}

/**
 * Collapses a run of same-name tool calls into one timeline row that expands
 * into its own nested rail. Expects two or more entries sharing a tool name.
 *
 * // Usage: <ToolCallGroupBlock calls={entries} />
 */
export function ToolCallGroupBlock({ calls, latestFileChangeId = null }: ToolCallGroupBlockProps) {
  const { t } = useI18n();
  const display = useChatDisplaySettings();
  const name = calls[0].name;
  const labels = t.tools.labels as Record<string, string> | undefined;
  const label = labels?.[name] ?? name;
  const firstHint = getToolHint(name, calls[0].args, (count) =>
    t.tools.moreCount.replace('{count}', String(count))
  );
  const moreCount = calls.length - 1;
  const moreLabel = t.tools.moreCount.replace('{count}', String(moreCount));

  const status = groupStatus(calls);
  const tone = toolStatusTone(status);
  const anyError = status === 'failed';
  const isActive = status === 'running';
  // File mutations group like any other repeated tool, so a group that holds a
  // card the display mode wants open has to open with it — otherwise the diff
  // preview is unreachable for the common run of consecutive edits.
  const holdsExpandedPreview = holdsPreviewToExpand(calls, latestFileChangeId, display);
  const [expanded, setExpanded] = useState(anyError || holdsExpandedPreview);

  /**
   * What the summary actually depends on, as something stable across frames.
   *
   * `planToolGroups` rebuilds `calls` from scratch on every stream token, so a
   * memo keyed on the array itself memoizes nothing — and `getToolGroupSummary`
   * re-`JSON.parse`s every member's result, which for a run of greps is the
   * largest string in the transcript. This tracks the three things that can
   * change the answer without touching any of the payloads: `length` is O(1) on
   * a string, so nothing here reads the results themselves.
   */
  const callSignature = calls
    .map((call) => `${call.toolCallId}:${call.status}:${call.result?.length ?? 0}`)
    .join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: callSignature stands in for the per-frame identity of `calls`
  const summary = useMemo(
    () => (isActive ? null : getToolGroupSummary(name, calls)),
    [isActive, name, callSignature]
  );
  // Wall-clock is not recoverable from a group (the calls may have overlapped),
  // so this is the run's total work, which is what the per-call rows also show.
  // Not memoized: it is arithmetic over a handful of numbers, and a memo would
  // have to guess at when a duration lands relative to its call's status.
  const measured = calls
    .map((call) => call.execution?.durationMs)
    .filter((value): value is number => typeof value === 'number');
  const duration =
    !isActive && measured.length === calls.length && measured.length > 0
      ? measured.reduce((sum, value) => sum + value, 0)
      : null;

  useEffect(() => {
    if (anyError || holdsExpandedPreview) setExpanded(true);
  }, [anyError, holdsExpandedPreview]);

  return (
    <TimelineItem tone={tone}>
      <TimelineRow
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        glyph={<StatusGlyph status={status} name={name} />}
        summary={summary ? formatToolSummary(summary, t.tools.summary) : null}
        duration={duration === null ? null : formatToolDuration(duration)}
      >
        <span className={`shrink-0 font-mono font-semibold ${toneTextClass(tone)}`}>{label}</span>
        {firstHint && (
          <span className="truncate font-mono text-on-surface-variant/60">{firstHint}</span>
        )}
        {moreCount > 0 && (
          <span className="shrink-0 rounded-sm bg-surface-container-high px-1 py-px text-[10px] text-on-surface-variant/70">
            {moreLabel}
          </span>
        )}
      </TimelineRow>

      {/* A group opens onto a nested rail, not onto a card. */}
      <TimelineDisclosure open={expanded} className="chat-timeline mt-1">
        {calls.map((call) => (
          <ToolCallBlock
            key={call.toolCallId}
            name={call.name}
            args={call.args}
            result={call.result}
            status={call.status}
            execution={call.execution}
            isLatestFileChange={call.toolCallId === latestFileChangeId}
          />
        ))}
      </TimelineDisclosure>
    </TimelineItem>
  );
}

/**
 * Whether any grouped call renders a diff preview the display mode opens by
 * default. Mirrors ToolCallBlock's own gate so the two cannot disagree.
 */
function holdsPreviewToExpand(
  calls: ToolCallEntry[],
  latestFileChangeId: string | null,
  display: ChatDisplaySettings
): boolean {
  if (!display.diffPreviewsEnabled || display.diffPreviewMode === 'collapsed') return false;
  return calls.some(
    (call) =>
      isFileChangeTool(call.name) &&
      call.status !== 'failed' &&
      call.status !== 'timed_out' &&
      (display.diffPreviewMode === 'expanded' || call.toolCallId === latestFileChangeId)
  );
}
