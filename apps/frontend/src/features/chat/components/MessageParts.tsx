import type { MessagePart } from '@mangostudio/shared';
import { ASK_USER_QUESTION_TOOL_NAME } from '@mangostudio/shared/questions';
import { TODO_WRITE_TOOL_NAME } from '@mangostudio/shared/todos';
import type { ExternalTurnPart } from '@mangostudio/shared/types';
import { ChevronDown, ChevronRight, Ellipsis } from 'lucide-react';
import { useMemo, useState } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import { useI18n } from '@/hooks/use-i18n';
import { formatTokensCompact } from '@/lib/format-tokens';
import { formatMessage } from '@/lib/i18n-format';
import { ContinuationEventMarker } from './ContinuationEventMarker';
import { ElicitationCard } from './ElicitationCard';
import { ExternalActivityBlock } from './ExternalActivityBlock';
import { ExternalApprovalCard } from './ExternalApprovalCard';
import { ExternalSteerPartBlock } from './ExternalSteerPartBlock';
import { findLatestFileChangeId } from './file-change-preview';
import { GeneratedImagePart } from './GeneratedImagePart';
import { McpMediaPartBlock } from './McpMediaPartBlock';
import { QuestionCard } from './QuestionCard';
import { SystemEventMarker } from './SystemEventMarker';
import { ThinkingBlock } from './ThinkingBlock';
import { TimelineItem } from './TimelineItem';
import { TimelineRow } from './TimelineRow';
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
  // Covers the gaps no vendor event describes: waiting on the API before the
  // first token, a long-running activity between updates, the turn between
  // two tool calls. Two trailing shapes already say enough on their own and
  // must not get a second, redundant (or outright wrong) cue stacked on top:
  // `text`/`thinking` mid-stream already shows its own caret or pulse, and an
  // approval nobody has answered yet is waiting on the *user*, not the vendor
  // — "Working..." under an unresolved decision would claim the opposite of
  // what is actually true.
  const trailingPart = parts.at(-1);
  const trailingIsLiveText =
    isStreaming && (trailingPart?.type === 'text' || trailingPart?.type === 'thinking');
  const trailingAwaitsDecision =
    trailingPart?.type === 'external_approval' && trailingPart.decisionSource === undefined;
  const showWorkingIndicator =
    externalTurn?.status === 'active' && !trailingIsLiveText && !trailingAwaitsDecision;
  return (
    <>
      <div className="chat-timeline min-w-0">
        {parts.map((part, idx) => {
          switch (part.type) {
            case 'external_turn':
              return null;
            // Owns its own timeline item: the vendor's status decides the node
            // tone, the same way a MangoStudio tool call does.
            case 'external_activity':
              return <ExternalActivityBlock key={`${part.callId}-activity`} part={part} />;
            case 'external_approval':
              return (
                <TimelineItem key={`${part.requestId}-approval`} variant="block">
                  <ExternalApprovalCard part={part} chatId={chatId} />
                </TimelineItem>
              );
            case 'external_steer':
              return (
                <TimelineItem key={`${part.clientMessageId}-steer`} variant="block">
                  <ExternalSteerPartBlock part={part} />
                </TimelineItem>
              );
            case 'thinking': {
              const blockId = `${messageId}-thinking-${idx}`;
              // A thought is over the moment anything follows it: the reducer
              // clears its active index on every other kind of chunk, so the
              // thinking part being streamed into is always the last one.
              // Asking instead whether a *later thinking part* exists left the
              // finished thought pulsing, expanded and uncounted for the rest
              // of the turn.
              return (
                <ThinkingBlock
                  key={blockId}
                  messageId={blockId}
                  text={part.text}
                  isStreaming={isStreaming && idx === parts.length - 1}
                  incomplete={part.incomplete}
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
              return (
                <TimelineItem key={part.imageId} variant="block">
                  <GeneratedImagePart part={part} />
                </TimelineItem>
              );
            case 'mcp_media':
              return (
                <TimelineItem key={`${part.toolCallId}-${part.url}`} variant="block">
                  <McpMediaPartBlock part={part} />
                </TimelineItem>
              );
            case 'question':
              return (
                <TimelineItem key={`${part.toolCallId}-question`} variant="block" tone="active">
                  <QuestionCard part={part} onSubmit={isStreaming ? undefined : onQuestionSubmit} />
                </TimelineItem>
              );
            case 'mcp_elicitation':
              return (
                <TimelineItem key={part.elicitationId} variant="block" tone="active">
                  <ElicitationCard part={part} />
                </TimelineItem>
              );
            case 'todo':
              return (
                <TimelineItem key={`${part.toolCallId}-todo`} variant="block">
                  <TodoListPart part={part} />
                </TimelineItem>
              );
            case 'subagent_trace':
              return (
                <TimelineItem
                  // biome-ignore lint/suspicious/noArrayIndexKey: message parts do not expose stable ids
                  key={`${messageId}-subagent-${idx}`}
                  variant="block"
                >
                  <SubagentTraceBlock part={part} />
                </TimelineItem>
              );
            case 'text': {
              const isStreamingIntoPart = isStreaming && idx === parts.length - 1;
              return (
                <TimelineItem
                  // Parts within a message are append-only and position-stable, so
                  // the ordinal index is a valid identity. No part-level ID exists.
                  // biome-ignore lint/suspicious/noArrayIndexKey: message parts do not expose stable ids
                  key={`${messageId}-text-${idx}`}
                  variant="block"
                >
                  <div className="chat-message-body max-w-2xl font-body leading-relaxed text-on-surface">
                    {/* Vendor prose goes through the same renderer as a
                        MangoStudio turn's. A vendor writes markdown because it
                        assumes a terminal renders it, so plain text showed its
                        `##` and `**` raw. The renderer — not the caller — is the
                        trust boundary: raw html is escaped, link and image
                        targets are scheme-checked, and an image is downgraded to
                        an anchor, so no vendor markup reaches the DOM live. */}
                    <MarkdownContent
                      content={part.text}
                      isStreaming={isStreamingIntoPart}
                      copyCodeLabel={t.chat.copyCode}
                      codeCopiedLabel={t.chat.codeCopied}
                    />
                    {part.incomplete ? (
                      <span className="mt-1 block text-xs italic text-on-surface-variant/50">
                        {t.externalAgents.turn.incomplete}
                      </span>
                    ) : null}
                  </div>
                </TimelineItem>
              );
            }
            case 'system_event':
              return (
                <TimelineItem
                  // biome-ignore lint/suspicious/noArrayIndexKey: message parts do not expose stable ids
                  key={`${messageId}-se-${idx}`}
                  variant="divider"
                >
                  <SystemEventMarker event={part.event} detail={part.detail} />
                </TimelineItem>
              );
            case 'continuation_transition':
              return (
                <TimelineItem
                  // biome-ignore lint/suspicious/noArrayIndexKey: message parts do not expose stable ids
                  key={`${messageId}-ct-${idx}`}
                  variant="divider"
                >
                  <ContinuationEventMarker
                    provider={part.provider}
                    modelName={part.modelName}
                    fromProvider={part.fromProvider}
                    fromMode={part.fromMode}
                    toMode={part.toMode}
                    reasonCode={part.reasonCode}
                    recovered={part.recovered}
                  />
                </TimelineItem>
              );
            case 'error':
              return (
                <TimelineItem
                  // biome-ignore lint/suspicious/noArrayIndexKey: message parts do not expose stable ids
                  key={`${messageId}-error-${idx}`}
                  variant="block"
                  tone="error"
                >
                  <div className="max-w-2xl rounded-xl border border-error/20 bg-error/10 p-4 font-body text-sm text-error">
                    {part.text}
                  </div>
                </TimelineItem>
              );
            default:
              return null;
          }
        })}
        {showWorkingIndicator ? <ExternalTurnWorkingIndicator /> : null}
      </div>
      {externalTurn?.type === 'external_turn' ? (
        <ExternalTurnFooter part={externalTurn} isStreaming={isStreaming} />
      ) : null}
    </>
  );
}

/**
 * A trailing row saying the turn has not gone idle, for whatever gap no
 * vendor event describes: no `system_event` for "still waiting on the API",
 * no delta for a long `Bash` between chunks of output, nothing at all for the
 * pause between one tool call ending and the next one starting.
 */
function ExternalTurnWorkingIndicator() {
  const { t } = useI18n();
  return (
    <TimelineItem tone="active">
      <TimelineRow
        expanded={false}
        onToggle={() => undefined}
        disclosable={false}
        glyph={<Ellipsis size={11} className="animate-pulse shrink-0" />}
      >
        <span className="animate-pulse text-on-surface-variant">
          {t.externalAgents.turn.working}
        </span>
      </TimelineRow>
    </TimelineItem>
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
    <div className="mt-2 max-w-2xl space-y-1.5 pl-4">
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

function SubagentTraceBlock({ part }: { part: Extract<MessagePart, { type: 'subagent_trace' }> }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const labels = t.chat.feed;
  const statusLabel = getSubagentStatusLabel(part.status, labels);
  const toolCountLabel =
    part.toolCallCount > 0
      ? formatMessage(labels.subagentTools, { count: String(part.toolCallCount) })
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
  return formatMessage(labels.subagentLifecycleAttempt, {
    attempt: String(event.attempt ?? 1),
  });
}
