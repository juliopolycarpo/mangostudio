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
import { toolSubjectKey } from '@mangostudio/shared/tool-identity';
import type { ExternalActivityPart } from '@mangostudio/shared/types';
import {
  Ban,
  CheckCircle,
  ChevronDown,
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
import { useToolIdentities } from '@/features/environments/identity/use-tool-identities';
import { useI18n } from '@/hooks/use-i18n';

/**
 * The icon comes from the neutral kind, never from the vendor's tool name.
 *
 * The name is the vendor's word and is shown verbatim; matching on it to pick a
 * picture would be MangoStudio deciding it knows what `shell` means in someone
 * else's product.
 */
function ActivityIcon({ kind, className }: { kind: ExternalActivityKind; className?: string }) {
  const size = 11;
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

function statusTone(part: ExternalActivityPart): string {
  if (part.isError || part.status === 'failed') return 'border-error/30 text-error';
  if (part.status === 'cancelled') return 'border-outline-variant/30 text-on-surface-variant';
  if (part.status === 'completed') return 'border-success/25 text-success';
  return 'border-primary/30 text-primary';
}

function StatusIcon({ part }: { part: ExternalActivityPart }) {
  if (part.isError || part.status === 'failed') return <Ban size={11} className="shrink-0" />;
  if (part.status === 'cancelled') return <Ban size={11} className="shrink-0" />;
  if (part.status === 'completed') return <CheckCircle size={11} className="shrink-0" />;
  return <ActivityIcon kind={part.kind} className="animate-pulse shrink-0" />;
}

function statusLabel(
  part: ExternalActivityPart,
  labels: {
    statusRunning: string;
    statusCompleted: string;
    statusFailed: string;
    statusCancelled: string;
  }
): string {
  if (part.status === 'running') return labels.statusRunning;
  if (part.status === 'completed') return labels.statusCompleted;
  if (part.status === 'cancelled') return labels.statusCancelled;
  return labels.statusFailed;
}

export interface ExternalActivityBlockProps {
  part: ExternalActivityPart;
}

/**
 * Usage: <ExternalActivityBlock part={part} />
 */
export function ExternalActivityBlock({ part }: ExternalActivityBlockProps) {
  const { t } = useI18n();
  const labels = t.externalAgents.activity;
  const { resolve } = useToolIdentities();
  const [expanded, setExpanded] = useState(false);

  // `agent:<targetId>` is already a valid identity subject with storage, an
  // edit dialog and an avatar palette, so renaming Codex in Environments renames
  // it here for free. Most users will have no row, and the derived name and
  // monogram are what they see — so that is the path that has to look finished.
  const identity = resolve('agent', part.targetId);
  const hasDetail = Boolean(part.detail);

  return (
    <div className="max-w-2xl">
      <button
        type="button"
        onClick={() => hasDetail && setExpanded((value) => !value)}
        aria-expanded={hasDetail ? expanded : undefined}
        className={`flex w-full items-center gap-2 rounded-full border bg-surface-container-lowest px-2.5 py-1 text-left text-[11px] ${statusTone(part)} ${
          hasDetail ? 'cursor-pointer' : 'cursor-default'
        }`}
      >
        <ToolAvatar
          subjectKey={toolSubjectKey('agent', part.targetId)}
          monogram={identity.monogram}
          name={identity.name}
          image={identity.image}
          size="xs"
          className="shrink-0"
        />
        <StatusIcon part={part} />
        {/* The vendor's own tool name, verbatim and inert. */}
        <span className="font-medium text-on-surface">{part.name}</span>
        {part.title ? (
          <span className="min-w-0 flex-1 truncate text-on-surface-variant/80">{part.title}</span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {part.truncated ? (
          <span className="shrink-0 text-on-surface-variant/60" title={labels.truncatedHint}>
            <span aria-hidden>…</span>
            <span className="sr-only">{labels.truncatedHint}</span>
          </span>
        ) : null}
        {hasDetail ? (
          <ChevronDown
            size={12}
            className={`shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
        ) : null}
      </button>

      {expanded && part.detail ? (
        <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-surface-container-high px-3 py-2 text-[11px] text-on-surface-variant">
          {part.detail}
        </pre>
      ) : null}

      {/* Attribution and outcome for a reader who cannot see the avatar or the
          border colour that carry them visually. */}
      <span className="sr-only">
        {`${labels.attribution.replace('{agent}', identity.name)} ${statusLabel(part, labels)}`}
      </span>
    </div>
  );
}
