import type { MessagePart } from '@mangostudio/shared';
import { useMemo } from 'react';
import { ContinuationEventMarker } from './ContinuationEventMarker';
import { ElicitationCard } from './ElicitationCard';
import { ExternalActivityBlock } from './ExternalActivityBlock';
import { ExternalApprovalCard } from './ExternalApprovalCard';
import { ExternalSteerPartBlock } from './ExternalSteerPartBlock';
import { findLatestFileChangeId } from './file-change-preview';
import { GeneratedImagePart } from './GeneratedImagePart';
import { McpMediaPartBlock } from './McpMediaPartBlock';
import { AssistantProsePart } from './parts/AssistantProsePart';
import { ErrorPart } from './parts/ErrorPart';
import { ExternalTurnFooter } from './parts/ExternalTurnFooter';
import { SubagentTracePart } from './parts/SubagentTracePart';
import { ToolCallPart } from './parts/ToolCallPart';
import { TurnWorkingRow } from './parts/TurnWorkingRow';
import { QuestionCard } from './QuestionCard';
import { SystemEventMarker } from './SystemEventMarker';
import { ThinkingBlock } from './ThinkingBlock';
import { TimelineItem } from './TimelineItem';
import { TodoListPart } from './TodoListPart';
import { planToolGroups } from './tool-call-grouping';

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
  const { groups, consumed } = useMemo(
    () => planToolGroups(parts, isStreaming),
    [parts, isStreaming]
  );
  const latestFileChangeId = useMemo(() => findLatestFileChangeId(parts), [parts]);
  // The turn record is written first so nothing is ever a bare text blob with no
  // record of who produced it, but it *reads* as a summary, so it renders last.
  const externalTurn = useMemo(() => parts.find((part) => part.type === 'external_turn'), [parts]);
  // Covers the gaps no vendor event describes: waiting on the API before the
  // first token, the pause between one tool call ending and the next starting.
  // Three trailing shapes already say enough on their own and must not get a
  // second, redundant (or outright wrong) cue stacked on top: `text`/`thinking`
  // mid-stream already shows its own caret or pulse; a call still running
  // already renders as running, and a second row under it would read as a
  // *second* thing happening; and an approval nobody has answered yet is
  // waiting on the *user*, not the vendor — "Working..." under an unresolved
  // decision would claim the opposite of what is actually true.
  const trailingPart = parts.at(-1);
  const trailingIsLiveText =
    isStreaming && (trailingPart?.type === 'text' || trailingPart?.type === 'thinking');
  const trailingIsRunningActivity =
    trailingPart?.type === 'external_activity' && trailingPart.status === 'running';
  const trailingAwaitsDecision =
    trailingPart?.type === 'external_approval' && trailingPart.decisionSource === undefined;
  const showWorkingIndicator =
    externalTurn?.status === 'active' &&
    !trailingIsLiveText &&
    !trailingIsRunningActivity &&
    !trailingAwaitsDecision;
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
            case 'tool_call':
              return (
                <ToolCallPart
                  key={part.toolCallId}
                  part={part}
                  parts={parts}
                  index={idx}
                  isStreaming={isStreaming}
                  group={groups.get(idx)}
                  consumed={consumed.has(idx)}
                  latestFileChangeId={latestFileChangeId}
                />
              );
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
            // The interrupted-turn notice above the composer speaks for the
            // checkpoint; it is a turn-level fact, not a timeline row.
            case 'turn_checkpoint':
              return null;
            case 'subagent_trace':
              return (
                <TimelineItem
                  // biome-ignore lint/suspicious/noArrayIndexKey: message parts do not expose stable ids
                  key={`${messageId}-subagent-${idx}`}
                  variant="block"
                >
                  <SubagentTracePart part={part} />
                </TimelineItem>
              );
            case 'text':
              return (
                <TimelineItem
                  // Message parts are append-only and position-stable, so the
                  // ordinal index is a valid identity. No part-level ID exists.
                  // biome-ignore lint/suspicious/noArrayIndexKey: message parts do not expose stable ids
                  key={`${messageId}-text-${idx}`}
                  variant="bubble"
                >
                  <AssistantProsePart
                    text={part.text}
                    isStreaming={isStreaming && idx === parts.length - 1}
                    incomplete={part.incomplete}
                  />
                </TimelineItem>
              );
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
                  <ErrorPart text={part.text} />
                </TimelineItem>
              );
            default: {
              // Every kind of `MessagePart` is handled above; adding one to the
              // union is a type error here. A part persisted by a newer server
              // still renders nothing rather than breaking the feed.
              const _exhaustive: never = part;
              void _exhaustive;
              return null;
            }
          }
        })}
        {showWorkingIndicator ? <TurnWorkingRow /> : null}
      </div>
      {externalTurn?.type === 'external_turn' ? (
        <ExternalTurnFooter part={externalTurn} isStreaming={isStreaming} />
      ) : null}
    </>
  );
}
