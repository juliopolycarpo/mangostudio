import type { MessagePart } from '@mangostudio/shared';
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
  /** toolCallId of the message's most recent file mutation, if any. */
  latestFileChangeId?: string | null;
}

/**
 * One tool call in the timeline: the collapsed block for a lone call, or the
 * grouped block for the run it leads.
 *
 * The caller filters out the question card's and todo checklist's own calls,
 * and calls a group already rendered, so this only ever mounts for a call that
 * has something to draw.
 *
 * // Usage: <ToolCallPart part={part} parts={parts} index={idx} isStreaming={false} />
 */
export function ToolCallPart({
  part,
  parts,
  index,
  isStreaming,
  group,
  latestFileChangeId,
}: ToolCallPartProps) {
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
