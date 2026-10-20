import type { MessagePart } from '@mangostudio/shared/types';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';

type SubagentTracePartValue = Extract<MessagePart, { type: 'subagent_trace' }>;
type FeedLabels = ReturnType<typeof useI18n>['t']['chat']['feed'];

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
    <div className="max-w-2xl rounded-2xl border border-stroke bg-surface text-sm text-fg">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-start gap-3 p-4 text-left"
      >
        <span className="mt-0.5 text-fg-muted">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-fg">{part.agentName}</span>
            <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-fg-muted">
              {labels.subagentTrace}
            </span>
            <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-fg-muted">
              {statusLabel}
            </span>
            <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-fg-muted">
              {toolCountLabel}
            </span>
          </span>
          <span className="block truncate text-fg-muted">{part.lastMessage ?? part.summary}</span>
        </span>
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-stroke p-4">
          {part.events?.length ? (
            <div className="space-y-2">
              <h4 className="text-xs font-bold uppercase tracking-widest text-fg-muted">
                {labels.subagentLifecycle}
              </h4>
              <div className="space-y-1.5">
                {part.events.map((event, index) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: message parts do not expose stable ids
                    key={`${part.toolCallId}-event-${index}`}
                    className="flex items-center justify-between gap-3 rounded-xl bg-surface px-3 py-2 text-xs text-fg-muted"
                  >
                    <span>{getSubagentTraceEventLabel(event, labels)}</span>
                    {event.attempt ? (
                      <span className="rounded-full bg-control px-2 py-0.5 font-medium">
                        #{event.attempt}
                      </span>
                    ) : null}
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
              <h4 className="text-xs font-bold uppercase tracking-widest text-fg-muted">
                {labels.subagentMessages}
              </h4>
              <div className="space-y-2">
                {part.messages.map((message, index) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: message parts do not expose stable ids
                    key={`${part.toolCallId}-message-${index}`}
                    className="rounded-xl bg-surface px-3 py-2 text-fg-muted"
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
              <h4 className="text-xs font-bold uppercase tracking-widest text-fg-muted">
                {labels.subagentToolCalls}
              </h4>
              <div className="flex flex-wrap gap-2">
                {part.tools.map((tool) => (
                  <span
                    key={tool.callId}
                    className="rounded-full bg-surface px-2.5 py-1 text-xs text-fg-muted"
                  >
                    {tool.name}
                  </span>
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
      <h4 className="text-xs font-bold uppercase tracking-widest text-fg-muted">{title}</h4>
      <div className="rounded-xl bg-surface px-3 py-2 text-fg-muted">
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
