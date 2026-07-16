/**
 * OpenAI bindings for the shared Responses protocol stream core.
 */

import type OpenAI from 'openai';
import type { ResponsesRequestPolicy } from '../core/responses-protocol/request-builder';
import { streamAgentTurnWithResponses, streamResponses } from '../core/responses-protocol/stream';
import type { AgentEvent, AgentTurnRequest, StreamingChunk, TextGenerationRequest } from '../types';

const OPENAI_RESPONSES_POLICY: ResponsesRequestPolicy = {
  provider: 'openai',
  store: true,
  continuation: 'previous-response-id',
  instructions: 'system-prompt',
  allowMaxOutputTokens: true,
};

export async function* streamWithResponsesAPI(
  client: OpenAI,
  req: TextGenerationRequest
): AsyncIterable<StreamingChunk> {
  yield* streamResponses(client, req, OPENAI_RESPONSES_POLICY);
}

export async function* streamAgentTurnWithResponsesAPI(
  client: OpenAI,
  req: AgentTurnRequest
): AsyncGenerator<AgentEvent> {
  yield* streamAgentTurnWithResponses(client, req, OPENAI_RESPONSES_POLICY);
}
