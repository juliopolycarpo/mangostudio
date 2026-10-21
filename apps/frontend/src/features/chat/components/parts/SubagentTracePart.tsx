import type { MessagePart } from '@mangostudio/shared/types';
import { type ComponentProps, useState } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import { Badge } from '@/components/ui/Badge';
import { Chip } from '@/components/ui/Chip';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { DisclosureChevron } from '../DisclosureChevron';

type SubagentTracePartValue = Extract<MessagePart, { type: 'subagent_trace' }>;
type FeedLabels = ReturnType<typeof useI18n>['t']['chat']['feed'];
type BadgeVariant = NonNullable<ComponentProps<typeof Badge>['variant']>;

/** How a finished or running delegation reads at a glance, beside its word. */
const STATUS_VARIANT: Record<SubagentTracePartValue['status'], BadgeVariant> = {
  completed: 'success',
  running: 'accent',
  aborted: 'neutral',
  timeout: 'warning',
  failed: 'error',
};

interface SubagentTracePartProps {
  part: SubagentTracePartValue;
}

/**
 * A delegated subagent run, collapsed to its headline and expandable into the
 * lifecycle events, messages and tool calls it produced.
 *
 * // Usage: <SubagentTracePart part={part} />
 */
export function SubagentTracePart({ part }: SubagentTracePartProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const labels = t.chat.feed;
  const statusLabel = getSubagentStatusLabel(part.status, labels);
  const toolCountLabel =
    part.toolCallCount > 0
      ? formatMessage(labels.subagentTools, { count: String(part.toolCallCount) })
      : labels.subagentNoTools;

  return (
    <div className="max-w-(--timeline-card-max) overflow-hidden rounded-md border border-stroke bg-surface text-sm text-fg">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full cursor-pointer items-start gap-3 p-4 text-left transition-colors hover:bg-fill-hover"
      >
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-fg">{part.agentName}</span>
            <Badge variant={STATUS_VARIANT[part.status]}>{statusLabel}</Badge>
            <Badge>{toolCountLabel}</Badge>
          </span>
          <span className="block truncate text-fg-muted">{part.lastMessage ?? part.summary}</span>
        </span>
        {/* Level with the first line (the badges are 20px), not the card's middle. */}
        <DisclosureChevron expanded={expanded} className="mt-1" />
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-stroke p-4">
          {part.events?.length ? (
            <div className="space-y-2">
              <MicroLabel as="h4">{labels.subagentLifecycle}</MicroLabel>
              <div className="space-y-1.5">
                {part.events.map((event, index) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: message parts do not expose stable ids
                    key={`${part.toolCallId}-event-${index}`}
                    className="flex items-center justify-between gap-3 rounded-sm bg-canvas px-3 py-2 text-xs text-fg-muted"
                  >
                    <span>{getSubagentTraceEventLabel(event, labels)}</span>
                    {event.attempt ? <Badge>#{event.attempt}</Badge> : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {part.lastMessage ? (
            <TraceSection title={labels.subagentLastMessage} body={part.lastMessage} />
          ) : null}
          {part.messages.length > 0 ? (
            <div className="space-y-2">
              <MicroLabel as="h4">{labels.subagentMessages}</MicroLabel>
              <div className="space-y-2">
                {part.messages.map((message, index) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: message parts do not expose stable ids
                    key={`${part.toolCallId}-message-${index}`}
                    className="rounded-sm bg-canvas px-3 py-2 text-fg-muted"
                  >
                    <MarkdownContent
                      content={message.text}
                      copyCodeLabel={t.chat.copyCode}
                      codeCopiedLabel={t.chat.codeCopied}
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {part.tools.length > 0 ? (
            <div className="space-y-2">
              <MicroLabel as="h4">{labels.subagentToolCalls}</MicroLabel>
              <div className="flex flex-wrap gap-2">
                {part.tools.map((tool) => (
                  <Chip key={tool.callId}>{tool.name}</Chip>
                ))}
              </div>
            </div>
          ) : null}
          {part.error ? (
            <TraceSection title={labels.subagentStatusFailed} body={part.error} />
          ) : null}
        </div>
      )}
    </div>
  );
}

function TraceSection({ title, body }: { title: string; body: string }) {
  const { t } = useI18n();
  return (
    <div className="space-y-2">
      <MicroLabel as="h4">{title}</MicroLabel>
      <div className="rounded-sm bg-canvas px-3 py-2 text-fg-muted">
        <MarkdownContent
          content={body}
          copyCodeLabel={t.chat.copyCode}
          codeCopiedLabel={t.chat.codeCopied}
        />
      </div>
    </div>
  );
}

function getSubagentStatusLabel(
  status: SubagentTracePartValue['status'],
  labels: FeedLabels
): string {
  if (status === 'completed') return labels.subagentStatusCompleted;
  if (status === 'aborted') return labels.subagentStatusAborted;
  if (status === 'timeout') return labels.subagentStatusTimeout;
  if (status === 'running') return labels.statusGenerating;
  return labels.subagentStatusFailed;
}

function getSubagentTraceEventLabel(
  event: NonNullable<SubagentTracePartValue['events']>[number],
  labels: FeedLabels
): string {
  if (event.event === 'delegation_started') return labels.subagentLifecycleDelegationStarted;
  if (event.event === 'delegation_completed') return labels.subagentLifecycleDelegationCompleted;
  if (event.event === 'delegation_failed') return labels.subagentLifecycleDelegationFailed;
  if (event.event === 'response_recovered') return labels.subagentLifecycleRecovered;
  if (event.event === 'response_timeout') return labels.subagentLifecycleTimeout;
  if (event.event === 'response_fallback') return labels.subagentLifecycleFallback;
  return formatMessage(labels.subagentLifecycleAttempt, {
    attempt: String(event.attempt ?? 1),
  });
}
