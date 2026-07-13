/**
 * Client for mid-tool-call MCP form elicitation responses.
 */

import type { ApiErrorResponse } from '@mangostudio/shared/errors';
import type {
  RespondMcpElicitationBody,
  RespondMcpElicitationResponse,
} from '@mangostudio/shared/mcp';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

/** The elicitation no longer exists server-side (already resolved or expired). */
export class McpElicitationGoneError extends Error {}

/**
 * Resolves a pending elicitation so the awaited MCP tool call can resume.
 * Throws `McpElicitationGoneError` on a stale id so callers can reconcile
 * against the persisted terminal state instead of surfacing a submit error.
 * // Usage: await respondMcpElicitation(id, { action: 'accept', content })
 */
export async function respondMcpElicitation(
  elicitationId: string,
  body: RespondMcpElicitationBody
): Promise<RespondMcpElicitationResponse> {
  const { data, error } = await client.api.mcp
    .elicitations({ id: elicitationId })
    .respond.post(body);
  if (error) {
    const message = extractApiError(error.value, 'Failed to respond to elicitation.');
    const code = (error.value as Partial<ApiErrorResponse> | null)?.code;
    if (code === 'NOT_FOUND') throw new McpElicitationGoneError(message);
    throw new Error(message);
  }
  return data as RespondMcpElicitationResponse;
}
