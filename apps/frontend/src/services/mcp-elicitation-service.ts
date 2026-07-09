/**
 * Client for mid-tool-call MCP form elicitation responses.
 */

import type {
  RespondMcpElicitationBody,
  RespondMcpElicitationResponse,
} from '@mangostudio/shared/mcp';
import { client } from '@/lib/api-client';
import { extractApiError } from '@/lib/utils';

/**
 * Resolves a pending elicitation so the awaited MCP tool call can resume.
 * // Usage: await respondMcpElicitation(id, { action: 'accept', content })
 */
export async function respondMcpElicitation(
  elicitationId: string,
  body: RespondMcpElicitationBody
): Promise<RespondMcpElicitationResponse> {
  const { data, error } = await client.api.mcp
    .elicitations({ id: elicitationId })
    .respond.post(body);
  if (error) throw new Error(extractApiError(error.value, 'Failed to respond to elicitation.'));
  return data as RespondMcpElicitationResponse;
}
