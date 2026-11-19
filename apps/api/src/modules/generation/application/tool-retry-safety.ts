import type { ToolRetrySafety } from '@mangostudio/shared/tool-executions';

import { isMcpToolName } from '../../../services/mcp/tool-naming';
import { getTool } from '../../../services/tools';
import { DELEGATE_TO_AGENT_TOOL_NAME } from '../../../services/tools/builtin/delegate-to-agent';

/**
 * What an MCP server says about one of its tools (`annotations` on the MCP tool
 * descriptor). The server is untrusted, so these are hints about how loudly to
 * ask, never proof that a call is safe to run again.
 */
export interface McpToolRetryHints {
  readonly readOnlyHint?: boolean;
  readonly idempotentHint?: boolean;
}

export interface ClassifyToolRetrySafetyOptions {
  /** Hints for an `mcp__` tool, when the hub has them. Ignored for builtins. */
  readonly mcpHints?: McpToolRetryHints;
}

/**
 * Whether running a call to `name` again is safe, in the one vocabulary turn
 * recovery and the tool card share.
 *
 * - Builtins answer from the `retrySafety` their own registration declares. A
 *   tool that declares nothing, or is not registered, is `confirmation_required`.
 * - A builtin that writes outside a checkpointed path is never `safe_read`, and
 *   neither is subagent delegation, whatever its metadata says.
 * - MCP tools are `unknown`. A `readOnlyHint` or `idempotentHint` of `true`
 *   lowers that to `confirmation_required`: the reader is still asked, with
 *   less alarm. A hint never makes a call run without asking.
 *
 * // Usage: classifyToolRetrySafety('read_file') // 'safe_read'
 */
export function classifyToolRetrySafety(
  name: string,
  options: ClassifyToolRetrySafetyOptions = {}
): ToolRetrySafety {
  if (isMcpToolName(name)) return classifyMcpRetrySafety(options.mcpHints);
  if (name === DELEGATE_TO_AGENT_TOOL_NAME) return capDelegationRetrySafety(getTool(name));

  const tool = getTool(name);
  const declared = tool?.settings.retrySafety ?? 'confirmation_required';
  // A write nothing can undo is not a read, however the tool describes itself.
  if (declared === 'safe_read' && tool?.settings.uncheckpointedWriteSource !== undefined) {
    return 'confirmation_required';
  }
  return declared;
}

function classifyMcpRetrySafety(hints: McpToolRetryHints | undefined): ToolRetrySafety {
  return hints?.readOnlyHint === true || hints?.idempotentHint === true
    ? 'confirmation_required'
    : 'unknown';
}

/** Delegation runs another agent with its own tools: at best the hub cannot vouch for it. */
function capDelegationRetrySafety(tool: ReturnType<typeof getTool>): ToolRetrySafety {
  const declared = tool?.settings.retrySafety;
  return declared === 'confirmation_required' ? declared : 'unknown';
}
