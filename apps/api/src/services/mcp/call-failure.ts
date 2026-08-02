/**
 * Why an MCP tool call failed, as the hub can tell. The SDK error types stop
 * at the runtime boundary, so the runtime classifies and attaches the answer
 * as an error detail; the hub reads it back plus the two causes only it can
 * see — its own deadline expiring, and the runtime going away mid-call.
 */

import { RuntimeRemoteError } from '@mangostudio/runtime';
import { ToolExecutionTimedOutError } from '../tools/execution-timeout';

export type McpCallFailure = 'timeout' | 'server_closed' | 'other';

const MCP_FAILURES: ReadonlySet<string> = new Set<McpCallFailure>([
  'timeout',
  'server_closed',
  'other',
]);

/**
 * Classifies a thrown MCP call failure.
 * // Usage: if (classifyMcpCallFailure(error) === 'timeout') …
 */
export function classifyMcpCallFailure(error: unknown): McpCallFailure {
  // The hub's own protocol deadline; `translateRuntimeError` has already
  // turned the wire's TIMEOUT into this by the time a caller sees it.
  if (error instanceof ToolExecutionTimedOutError) return 'timeout';
  if (!(error instanceof RuntimeRemoteError)) return 'other';
  // A dead runtime took the MCP session down with it — indistinguishable, from
  // the turn's point of view, from the server itself closing.
  if (error.code === 'RUNTIME_UNAVAILABLE') return 'server_closed';
  // Runtime reports a missing session the same way; treat it as closed so the
  // turn does not surface it as a generic tool failure.
  if (error.details?.kind === 'mcp_session_missing') return 'server_closed';
  const failure = error.details?.mcpFailure;
  return typeof failure === 'string' && MCP_FAILURES.has(failure)
    ? (failure as McpCallFailure)
    : 'other';
}
