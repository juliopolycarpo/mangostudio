import type { MessagePart } from '@mangostudio/shared';

/**
 * Tool names whose consecutive calls collapse into a single grouped block.
 * Limited to repetitive filesystem reads where a flat list adds noise.
 */
export const GROUPABLE_TOOLS = new Set(['read_file', 'list_directory', 'glob', 'grep']);

/** A single tool call paired with its result, ready for rendering. */
export interface ToolCallEntry {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  result: string | null;
  isError?: boolean;
  isPending: boolean;
}

/** Maps the leader part index of each multi-call run to its rendered entries. */
export interface ToolGroupPlan {
  /** Leader index -> entries, only for runs of two or more calls. */
  groups: Map<number, ToolCallEntry[]>;
  /** Member indices already folded into a leader; skipped during render. */
  consumed: Set<number>;
}

/**
 * Plans how consecutive same-name groupable tool calls collapse for display.
 * Runs are contiguous (tool_result parts are transparent); any other part ends a run.
 *
 * // Usage: const { groups, consumed } = planToolGroups(parts, isStreaming);
 */
export function planToolGroups(parts: MessagePart[], isStreaming: boolean): ToolGroupPlan {
  const groups = new Map<number, ToolCallEntry[]>();
  const consumed = new Set<number>();

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.type !== 'tool_call' || consumed.has(i)) continue;
    if (!GROUPABLE_TOOLS.has(part.name)) continue;

    const members = collectRun(parts, i, part.name);
    if (members.length < 2) continue;

    groups.set(
      i,
      members.map((idx) => toEntry(parts, idx, isStreaming))
    );
    for (let m = 1; m < members.length; m++) consumed.add(members[m]);
  }

  return { groups, consumed };
}

/** Collects indices of a contiguous run of same-name tool calls starting at `start`. */
function collectRun(parts: MessagePart[], start: number, name: string): number[] {
  const members = [start];
  for (let j = start + 1; j < parts.length; j++) {
    const next = parts[j];
    if (next.type === 'tool_result') continue;
    if (next.type === 'tool_call' && next.name === name) {
      members.push(j);
      continue;
    }
    break;
  }
  return members;
}

/** Builds a render entry for the tool_call at `index`, resolving its matching result. */
function toEntry(parts: MessagePart[], index: number, isStreaming: boolean): ToolCallEntry {
  const call = parts[index];
  if (call.type !== 'tool_call') {
    throw new Error(`Expected tool_call at index ${index}`);
  }
  const result = parts.find((p) => p.type === 'tool_result' && p.toolCallId === call.toolCallId) as
    | Extract<MessagePart, { type: 'tool_result' }>
    | undefined;

  return {
    toolCallId: call.toolCallId,
    name: call.name,
    args: call.args,
    result: result?.content ?? null,
    isError: result?.isError,
    isPending: isStreaming && !result,
  };
}
