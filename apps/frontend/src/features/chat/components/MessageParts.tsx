import type { MessagePart } from '@mangostudio/shared';
import { ASK_USER_QUESTION_TOOL_NAME } from '@mangostudio/shared/questions';
import { TODO_WRITE_TOOL_NAME } from '@mangostudio/shared/todos';
import type { ExternalTurnPart } from '@mangostudio/shared/types';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import { useI18n } from '@/hooks/use-i18n';
import { ContinuationEventMarker } from './ContinuationEventMarker';
import { ElicitationCard } from './ElicitationCard';
import { ExternalActivityBlock } from './ExternalActivityBlock';
import { ExternalApprovalCard } from './ExternalApprovalCard';
import { findLatestFileChangeId } from './file-change-preview';
import { GeneratedImagePart } from './GeneratedImagePart';
import { McpMediaPartBlock } from './McpMediaPartBlock';
import { QuestionCard } from './QuestionCard';
import { SystemEventMarker } from './SystemEventMarker';
import { ThinkingBlock } from './ThinkingBlock';
import { TodoListPart } from './TodoListPart';
import { ToolCallBlock } from './ToolCallBlock';
import { ToolCallGroupBlock } from './ToolCallGroupBlock';
import { planToolGroups, toToolCallEntry } from './tool-call-grouping';

interface MessagePartsProps {
  parts: MessagePart[];
  messageId: string;
  isStreaming: boolean;
  /** The chat an approval would be answered against; absent makes cards inert. */
  chatId?: string | null;
  /** Present only while question cards are answerable (last message, idle). */
  onQuestionSubmit?: (prompt: string) => void;
}

export function MessageParts({
  parts,
  messageId,
  isStreaming,
  chatId = null,
  onQuestionSubmit,
}: MessagePartsProps) {
  const { t } = useI18n();
  const { groups, consumed } = useMemo(
    () => planToolGroups(parts, isStreaming),
    [parts, isStreaming]
  );
  const latestFileChangeId = useMemo(() => findLatestFileChangeId(parts), [parts]);
  // The turn record is written first so nothing is ever a bare text blob with no
  // record of who produced it, but it *reads* as a summary, so it renders last.
  const externalTurn = useMemo(() => parts.find((part) => part.type === 'external_turn'), [parts]);
  // The turn record is also the message-level marker for *who wrote the prose*.
  // Every `text` and `thinking` part in a message carrying it came from a vendor
  // process, and vendor text renders as plain text — markdown here would let a
  // third party emit links, images and formatting into MangoStudio's own UI.
  const vendorAuthored = externalTurn !== undefined;
  return (
    <>
      {parts.map((part, idx) => {
        switch (part.type) {
          case 'external_turn':
            return null;
          case 'external_activity':
            return <ExternalActivityBlock key={`${part.callId}-activity`} part={part} />;
          case 'external_approval':
            return (
              <ExternalApprovalCard
                key={`${part.requestId}-approval`}
                part={part}
                chatId={chatId}
              />
            );
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
                plainText={vendorAuthored}
              />
            );
          }
          case 'tool_call': {
            // The question card and the todo checklist supersede the generic
            // collapsed tool block for their calls.
            if (part.name === ASK_USER_QUESTION_TOOL_NAME) return null;
            if (part.name === TODO_WRITE_TOOL_NAME) return null;
            if (consumed.has(idx)) return null;
            const grouped = groups.get(idx);
            if (grouped) {
              return (
                <ToolCallGroupBlock
                  key={part.toolCallId}
                  calls={grouped}
                  latestFileChangeId={latestFileChangeId}
                />
              );
            }
            const entry = toToolCallEntry(parts, idx, isStreaming);
            return (
              <ToolCallBlock
                key={part.toolCallId}
                name={entry.name}
                args={entry.args}
                result={entry.result}
                status={entry.status}
                execution={entry.execution}
                isLatestFileChange={part.toolCallId === latestFileChangeId}
              />
            );
          }
          case 'tool_result':
            return null;
          case 'generated_image':
            return <GeneratedImagePart key={part.imageId} part={part} />;
          case 'mcp_media':
            return <McpMediaPartBlock key={`${part.toolCallId}-${part.url}`} part={part} />;
          case 'question':
            return (
              <QuestionCard
                key={`${part.toolCallId}-question`}
                part={part}
                onSubmit={isStreaming ? undefined : onQuestionSubmit}
              />
            );
          case 'mcp_elicitation':
            return <ElicitationCard key={part.elicitationId} part={part} />;
          case 'todo':
            return <TodoListPart key={`${part.toolCallId}-todo`} part={part} />;
          case 'subagent_trace':
            return (
              <SubagentTraceBlock
                // biome-ignore lint/suspicious/noArrayIndexKey: message parts do not expose stable ids
                key={`${messageId}-subagent-${idx}`}
                part={part}
              />
            );
          case 'text':
            return (
              <div
                // Parts within a message are append-only and position-stable, so
                // the ordinal index is a valid identity. No part-level ID exists.
                // biome-ignore lint/suspicious/noArrayIndexKey: message parts do not expose stable ids
                key={`${messageId}-text-${idx}`}
                className="bg-surface-container-low p-5 rounded-2xl border border-outline-variant/10 font-body text-sm leading-relaxed text-on-surface max-w-2xl"
              >
                {vendorAuthored ? (
                  <span data-vendor-text className="block whitespace-pre-wrap break-words">
                    {part.text}
                  </span>
                ) : (
                  <MarkdownContent
                    content={part.text}
                    isStreaming={isStreaming}
                    copyCodeLabel={t.chat.copyCode}
                    codeCopiedLabel={t.chat.codeCopied}
                  />
                )}
                {isStreaming && idx === parts.length - 1 && (
                  <span className="inline-block w-0.5 h-[1em] bg-primary ml-0.5 align-middle animate-blink" />
                )}
              </div>
            );
          case 'system_event':
            return (
              <SystemEventMarker
                // biome-ignore lint/suspicious/noArrayIndexKey: message parts do not expose stable ids
                key={`${messageId}-se-${idx}`}
                event={part.event}
                detail={part.detail}
              />
            );
          case 'continuation_transition':
            return (
              <ContinuationEventMarker
                // biome-ignore lint/suspicious/noArrayIndexKey: message parts do not expose stable ids
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
                // biome-ignore lint/suspicious/noArrayIndexKey: message parts do not expose stable ids
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
      {externalTurn?.type === 'external_turn' ? (
        <ExternalTurnFooter part={externalTurn} isStreaming={isStreaming} />
      ) : null}
    </>
  );
}

/**
 * What the vendor spent and why the turn stopped.
 *
 * Usage renders only the fields the vendor reported, and no total is computed
 * from them: an adapter reports what its vendor reports, and a sum MangoStudio
 * invented would read as the vendor's own number. Cost is out of scope entirely.
 */
function ExternalTurnFooter({
  part,
  isStreaming,
}: {
  part: ExternalTurnPart;
  isStreaming: boolean;
}) {
  const { t } = useI18n();
  const labels = t.externalAgents.turn;
  const usage = part.usage;
  const fields: Array<[string, number]> = usage
    ? (
        [
          [labels.usageInput, usage.inputTokens],
          [labels.usageOutput, usage.outputTokens],
          [labels.usageReasoning, usage.reasoningTokens],
          [labels.usageCacheRead, usage.cacheReadTokens],
          [labels.usageCacheWrite, usage.cacheWriteTokens],
          [labels.usageTotal, usage.totalTokens],
        ] as const
      ).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    : [];

  const terminalNotice =
    part.status === 'terminal' && part.terminalReason && part.terminalReason !== 'completed'
      ? labels.terminal[part.terminalReason]
      : null;

  if (fields.length === 0 && !terminalNotice && !part.error) return null;

  return (
    <div className="max-w-2xl space-y-1.5">
      {fields.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {fields.map(([label, value]) => (
            <span
              key={label}
              className="rounded-full border border-outline-variant/20 bg-surface-container-lowest px-2 py-0.5 text-[10px] tabular-nums text-on-surface-variant"
            >
              {`${label} ${formatTokensCompact(value)}`}
            </span>
          ))}
        </div>
      ) : null}
      {part.error ? (
        <p className="rounded-xl border border-error/20 bg-error/10 px-3 py-2 text-xs text-error">
          {/* The vendor's own code and message, inert and unflattened. */}
          <span className="font-mono">{part.error.code}</span>
          {` — ${part.error.message}`}
        </p>
      ) : null}
      {terminalNotice && !isStreaming ? (
        <p className="text-xs text-on-surface-variant/70">{terminalNotice}</p>
      ) : null}
    </div>
  );
}

/** Same compaction the composer's context chip uses, so one turn reads one way. */
function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
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
                    // biome-ignore lint/suspicious/noArrayIndexKey: message parts do not expose stable ids
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
                    // biome-ignore lint/suspicious/noArrayIndexKey: message parts do not expose stable ids
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
