/**
 * One thing a vendor CLI did, rendered and nothing more.
 *
 * A separate component rather than a prop on `ToolCallBlock`, deliberately. That
 * block carries re-run, retry and open-in-editor affordances whose assumptions
 * are MangoStudio's: a tool the executor owns, arguments it can replay, a result
 * it produced. None of that is true of a vendor's own tool call, and a flag
 * turning those off would be one refactor away from turning them back on.
 *
 * Every string here that came from the vendor — the tool name, the title, the
 * detail — is rendered as **plain text**. It is bounded and control-stripped at
 * the runtime boundary, but nothing has established that it is safe to interpret
 * as markdown, and a tool label that renders as a link is a phishing surface.
 */

import type { ExternalActivityKind } from '@mangostudio/shared/external-agents';
import type { ToolExecutionStatus } from '@mangostudio/shared/tool-executions';
import { toolSubjectKey } from '@mangostudio/shared/tool-identity';
import type { ExternalActivityPart } from '@mangostudio/shared/types';
import {
  FileDiff,
  Globe,
  ImagePlus,
  ListChecks,
  Plug,
  ScanEye,
  Shrink,
  Terminal,
  Users,
  Wrench,
} from 'lucide-react';
import { useState } from 'react';
import { ToolAvatar } from '@/components/ui/ToolAvatar';
import type { ToolIdentityResolver } from '@/features/environments/identity/use-tool-identities';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_SM } from '@/lib/icon-sizes';
import { agentRunnerName } from '../lib/turn-identity';
import { TIMELINE_PANEL_CLASS } from './TimelineDisclosure';
import { TimelineItem } from './TimelineItem';
import { TimelineRow } from './TimelineRow';
import { StatusGlyph, toneTextClass, toolStatusTone } from './ToolCallVisuals';

/**
 * The icon comes from the neutral kind, never from the vendor's tool name.
 *
 * The name is the vendor's word and is shown verbatim; matching on it to pick a
 * picture would be MangoStudio deciding it knows what `shell` means in someone
 * else's product.
 */
function ActivityIcon({ kind, className }: { kind: ExternalActivityKind; className?: string }) {
  const size = ICON_SM;
  switch (kind) {
    case 'command':
      return <Terminal size={size} className={className} />;
    case 'file-change':
      return <FileDiff size={size} className={className} />;
    case 'mcp':
      return <Plug size={size} className={className} />;
    case 'subagent':
      return <Users size={size} className={className} />;
    case 'web-search':
      return <Globe size={size} className={className} />;
    case 'image':
      return <ImagePlus size={size} className={className} />;
    case 'plan':
      return <ListChecks size={size} className={className} />;
    case 'review':
      return <ScanEye size={size} className={className} />;
    case 'compaction':
      return <Shrink size={size} className={className} />;
    default:
      return <Wrench size={size} className={className} />;
  }
}

/**
 * How this activity ended, in the words a MangoStudio tool row uses.
 *
 * One predicate for everything the row says about the outcome (the rail node,
 * the name's colour, the glyph, the word and the screen-reader sentence), with
 * `isError` winning: a vendor can report a call `completed` that still failed,
 * and a row whose glyph said so while its sentence said "Done" would argue with
 * itself. Mapping onto `ToolExecutionStatus` is what lets this row borrow the
 * native rows' tone and glyph tables instead of keeping a second pair.
 */
function executionStatusOf(part: ExternalActivityPart): ToolExecutionStatus {
  if (part.isError || part.status === 'failed') return 'failed';
  if (part.status === 'cancelled') return 'cancelled';
  if (part.status === 'completed') return 'succeeded';
  return 'running';
}

/**
 * The glyph a settled row draws is the tool rail's own verdict mark, so a
 * failed and a cancelled call differ by shape and not only by colour. A call
 * still running keeps the neutral kind icon: the shared glyph would pick one
 * from the vendor's tool name, which this file never does.
 */
function ActivityGlyph({
  part,
  status,
}: {
  part: ExternalActivityPart;
  status: ToolExecutionStatus;
}) {
  if (status === 'running')
    return <ActivityIcon kind={part.kind} className="animate-pulse shrink-0" />;
  return <StatusGlyph status={status} name={part.name} />;
}

function statusLabel(
  status: ToolExecutionStatus,
  labels: {
    statusRunning: string;
    statusCompleted: string;
    statusFailed: string;
    statusCancelled: string;
  }
): string {
  if (status === 'running') return labels.statusRunning;
  if (status === 'succeeded') return labels.statusCompleted;
  if (status === 'cancelled') return labels.statusCancelled;
  return labels.statusFailed;
}

export interface ExternalActivityBlockProps {
  part: ExternalActivityPart;
  /** Resolved once per feed by `ChatFeed`, not once per row. */
  toolIdentities: ToolIdentityResolver;
}

/**
 * Usage: <ExternalActivityBlock part={part} toolIdentities={identities} />
 */
export function ExternalActivityBlock({ part, toolIdentities }: ExternalActivityBlockProps) {
  const { t } = useI18n();
  const labels = t.externalAgents.activity;
  const { resolve } = toolIdentities;
  const [expanded, setExpanded] = useState(false);

  // `agent:<targetId>` is already a valid identity subject with storage, an
  // edit dialog and an avatar palette, so renaming Codex in Environments renames
  // it here for free. Most users will have no row, and the derived name and
  // monogram are what they see — so that is the path that has to look finished.
  const identity = resolve('agent', part.targetId);
  const agentName = agentRunnerName(identity, part.targetId, t.externalAgents.target);
  const hasDetail = Boolean(part.detail);
  const status = executionStatusOf(part);
  const tone = toolStatusTone(status);
  // A settled call that did not go to plan says so in words, as a MangoStudio
  // row does: the rail node and the glyph carry the tone, but a red and a grey
  // that differ only by hue are not a signal.
  const outcomeWord = status === 'failed' || status === 'cancelled' ? t.tools.status[status] : null;

  return (
    <TimelineItem tone={tone}>
      <TimelineRow
        expanded={hasDetail && expanded}
        onToggle={() => setExpanded((value) => !value)}
        disclosable={hasDetail}
        glyph={<ActivityGlyph part={part} status={status} />}
      >
        {/* Attribution stays on the row itself: an external turn interleaves
            several vendors' work in one transcript, and the turn header names
            only the one that opened it. */}
        <ToolAvatar
          subjectKey={toolSubjectKey('agent', part.targetId)}
          monogram={identity.monogram}
          name={agentName}
          image={identity.image}
          size="2xs"
          className="shrink-0"
        />
        {/* The vendor's own tool name, verbatim and inert. */}
        <span className={`shrink-0 font-mono font-semibold ${toneTextClass(tone)}`}>
          {part.name}
        </span>
        {part.title ? <span className="truncate font-mono text-fg-muted">{part.title}</span> : null}
        {outcomeWord ? (
          <span className={`shrink-0 ${toneTextClass(tone)}`}>{outcomeWord}</span>
        ) : null}
        {part.truncated ? (
          <span className="shrink-0 text-fg-subtle" title={labels.truncatedHint}>
            <span aria-hidden>…</span>
            <span className="sr-only">{labels.truncatedHint}</span>
          </span>
        ) : null}
      </TimelineRow>

      {expanded && part.detail ? (
        <pre
          className={`app-scrollbar max-h-64 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs text-fg-muted ${TIMELINE_PANEL_CLASS}`}
        >
          {part.detail}
        </pre>
      ) : null}

      {/* Attribution and outcome for a reader who cannot see the avatar or the
          tone that carry them visually. */}
      <span className="sr-only">
        {`${formatMessage(labels.attribution, { agent: agentName })} ${statusLabel(status, labels)}`}
      </span>
    </TimelineItem>
  );
}
