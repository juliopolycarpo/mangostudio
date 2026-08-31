import type { MessagePart } from '@mangostudio/shared';
import { ASK_USER_QUESTION_TOOL_NAME } from '@mangostudio/shared/questions';
import { TODO_WRITE_TOOL_NAME } from '@mangostudio/shared/todos';
import { ToolCallBlock } from '../ToolCallBlock';
import { ToolCallGroupBlock } from '../ToolCallGroupBlock';
import { type ToolCallEntry, toToolCallEntry } from '../tool-call-grouping';

interface ToolCallPartProps {
  part: Extract<MessagePart, { type: 'tool_call' }>;
  /** The whole message, needed to pair this call with its result part. */
  parts: MessagePart[];
  /** Index of `part` within `parts`. */
  index: number;
  isStreaming: boolean;
  /** Entries of the run this call leads, when it collapses several calls. */
  group?: ToolCallEntry[];
  /** True when an earlier group already rendered this call. */
  consumed: boolean;
  /** toolCallId of the message's most recent file mutation, if any. */
  latestFileChangeId?: string | null;
}

/**
 * One tool call in the timeline: the collapsed block for a lone call, or the
 * grouped block for the run it leads. Renders nothing for a call another part
 * already speaks for.
 *
 * // Usage: <ToolCallPart part={part} parts={parts} index={idx} isStreaming={false} consumed={false} />
 */
export function ToolCallPart({
  part,
  parts,
  index,
  isStreaming,
  group,
  consumed,
  latestFileChangeId,
}: ToolCallPartProps) {
  // The question card and the todo checklist supersede the generic collapsed
  // tool block for their calls.
  if (part.name === ASK_USER_QUESTION_TOOL_NAME) return null;
  if (part.name === TODO_WRITE_TOOL_NAME) return null;
  if (consumed) return null;

  if (group) {
    return <ToolCallGroupBlock calls={group} latestFileChangeId={latestFileChangeId} />;
  }

  const entry = toToolCallEntry(parts, index, isStreaming);
  return (
    <ToolCallBlock
      name={entry.name}
      args={entry.args}
      result={entry.result}
      status={entry.status}
      execution={entry.execution}
      isLatestFileChange={part.toolCallId === latestFileChangeId}
    />
  );
}
