import type { MessagePart } from '@mangostudio/shared';
import { useI18n } from '@/hooks/use-i18n';
import { MarkdownContent } from '@/components/MarkdownContent';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCallBlock } from './ToolCallBlock';
import { SystemEventMarker } from './SystemEventMarker';
import { ContinuationEventMarker } from './ContinuationEventMarker';
import { GeneratedImagePart } from './GeneratedImagePart';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';

interface MessagePartsProps {
  parts: MessagePart[];
  messageId: string;
  isStreaming: boolean;
}

export function MessageParts({ parts, messageId, isStreaming }: MessagePartsProps) {
  const { t } = useI18n();
  return (
    <>
      {parts.map((part, idx) => {
        switch (part.type) {
          case 'thinking': {
            const blockId = `${messageId}-thinking-${idx}`;
            const isLastThinking =
              isStreaming && !parts.slice(idx + 1).some((p) => p.type === 'thinking');
            return (
              <ThinkingBlock
                key={blockId}
                messageId={blockId}
                text={part.text}
                isStreaming={isLastThinking}
              />
            );
          }
          case 'tool_call': {
            const result = parts.find(
              (p) => p.type === 'tool_result' && p.toolCallId === part.toolCallId
            ) as Extract<MessagePart, { type: 'tool_result' }> | undefined;
            return (
              <ToolCallBlock
                key={part.toolCallId}
                name={part.name}
                args={part.args}
                result={result?.content ?? null}
                isError={result?.isError}
                isPending={isStreaming && !result}
              />
            );
          }
          case 'tool_result':
            return null;
          case 'generated_image':
            return <GeneratedImagePart key={part.imageId} part={part} />;
          case 'subagent_trace':
            return (
              <SubagentTraceBlock
                // eslint-disable-next-line @eslint-react/no-array-index-key
                key={`${messageId}-subagent-${idx}`}
                part={part}
              />
            );
          case 'text':
            return (
              <div
                // Parts within a message are append-only and position-stable, so
                // the ordinal index is a valid identity. No part-level ID exists.
                // eslint-disable-next-line @eslint-react/no-array-index-key
                key={`${messageId}-text-${idx}`}
                className="bg-surface-container-low p-5 rounded-2xl border border-outline-variant/10 font-body text-sm leading-relaxed text-on-surface max-w-2xl"
              >
                <MarkdownContent
                  content={part.text}
                  isStreaming={isStreaming}
                  copyCodeLabel={t.chat.copyCode}
                  codeCopiedLabel={t.chat.codeCopied}
                />
                {isStreaming && idx === parts.length - 1 && (
                  <span className="inline-block w-0.5 h-[1em] bg-primary ml-0.5 align-middle animate-blink" />
                )}
              </div>
            );
          case 'system_event':
            return (
              <SystemEventMarker
                // eslint-disable-next-line @eslint-react/no-array-index-key
                key={`${messageId}-se-${idx}`}
                event={part.event}
                detail={part.detail}
              />
            );
          case 'continuation_transition':
            return (
              <ContinuationEventMarker
                // eslint-disable-next-line @eslint-react/no-array-index-key
                key={`${messageId}-ct-${idx}`}
                provider={part.provider}
                modelName={part.modelName}
                fromProvider={part.fromProvider}
                fromMode={part.fromMode}
                toMode={part.toMode}
                reasonCode={part.reasonCode}
                recovered={part.recovered}
              />
            );
          case 'error':
            return (
              <div
                // eslint-disable-next-line @eslint-react/no-array-index-key
                key={`${messageId}-error-${idx}`}
                className="bg-error/10 border border-error/20 p-4 rounded-xl text-error text-sm font-body"
              >
                {part.text}
              </div>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

function SubagentTraceBlock({ part }: { part: Extract<MessagePart, { type: 'subagent_trace' }> }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const labels = t.chat.feed;
  const statusLabel = getSubagentStatusLabel(part.status, labels);
  const toolCountLabel =
    part.toolCallCount > 0
      ? labels.subagentTools.replace('{count}', String(part.toolCallCount))
      : labels.subagentNoTools;

  return (
    <div className="max-w-2xl rounded-2xl border border-outline-variant/15 bg-surface-container-low text-sm text-on-surface">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-start gap-3 p-4 text-left"
      >
        <span className="mt-0.5 text-on-surface-variant">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-on-surface">{part.agentName}</span>
            <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-xs text-on-surface-variant">
              {labels.subagentTrace}
            </span>
            <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-xs text-on-surface-variant">
              {statusLabel}
            </span>
            <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-xs text-on-surface-variant">
              {toolCountLabel}
            </span>
          </span>
          <span className="block truncate text-on-surface-variant/80">
            {part.lastMessage ?? part.summary}
          </span>
        </span>
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-outline-variant/10 p-4">
          {part.events?.length ? (
            <div className="space-y-2">
              <h4 className="text-xs font-bold uppercase tracking-widest text-on-surface-variant/80">
                {labels.subagentLifecycle}
              </h4>
              <div className="space-y-1.5">
                {part.events.map((event, index) => (
                  <div
                    // eslint-disable-next-line @eslint-react/no-array-index-key
                    key={`${part.toolCallId}-event-${index}`}
                    className="flex items-center justify-between gap-3 rounded-xl bg-surface-container-high px-3 py-2 text-xs text-on-surface-variant"
                  >
                    <span>{getSubagentTraceEventLabel(event, labels)}</span>
                    {event.attempt ? (
                      <span className="rounded-full bg-surface-container-lowest px-2 py-0.5 font-medium">
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
              <h4 className="text-xs font-bold uppercase tracking-widest text-on-surface-variant/80">
                {labels.subagentMessages}
              </h4>
              <div className="space-y-2">
                {part.messages.map((message, index) => (
                  <div
                    // eslint-disable-next-line @eslint-react/no-array-index-key
                    key={`${part.toolCallId}-message-${index}`}
                    className="rounded-xl bg-surface-container-high px-3 py-2 text-on-surface-variant"
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
              <h4 className="text-xs font-bold uppercase tracking-widest text-on-surface-variant/80">
                {labels.subagentToolCalls}
              </h4>
              <div className="flex flex-wrap gap-2">
                {part.tools.map((tool) => (
                  <span
                    key={tool.callId}
                    className="rounded-full bg-surface-container-high px-2.5 py-1 text-xs text-on-surface-variant"
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
      <h4 className="text-xs font-bold uppercase tracking-widest text-on-surface-variant/80">
        {title}
      </h4>
      <div className="rounded-xl bg-surface-container-high px-3 py-2 text-on-surface-variant">
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
  status: Extract<MessagePart, { type: 'subagent_trace' }>['status'],
  labels: ReturnType<typeof useI18n>['t']['chat']['feed']
): string {
  if (status === 'completed') return labels.subagentStatusCompleted;
  if (status === 'aborted') return labels.subagentStatusAborted;
  if (status === 'timeout') return labels.subagentStatusTimeout;
  if (status === 'running') return labels.statusGenerating;
  return labels.subagentStatusFailed;
}

function getSubagentTraceEventLabel(
  event: NonNullable<Extract<MessagePart, { type: 'subagent_trace' }>['events']>[number],
  labels: ReturnType<typeof useI18n>['t']['chat']['feed']
): string {
  if (event.event === 'delegation_started') return labels.subagentLifecycleDelegationStarted;
  if (event.event === 'delegation_completed') return labels.subagentLifecycleDelegationCompleted;
  if (event.event === 'delegation_failed') return labels.subagentLifecycleDelegationFailed;
  if (event.event === 'response_recovered') return labels.subagentLifecycleRecovered;
  if (event.event === 'response_timeout') return labels.subagentLifecycleTimeout;
  if (event.event === 'response_fallback') return labels.subagentLifecycleFallback;
  return labels.subagentLifecycleAttempt.replace('{attempt}', String(event.attempt ?? 1));
}
