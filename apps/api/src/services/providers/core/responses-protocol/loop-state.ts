/**
 * Turn-local loop state for the stateless Responses replay policy.
 *
 * Providers without a server-side cursor (store: false) must re-send every
 * conversation item on each request. Within one agentic turn the model's own
 * output items — reasoning (with encrypted_content), function calls, and
 * assistant messages — are not yet persisted as chat history, so they are
 * carried between tool iterations in providerState. The state also pins the
 * per-turn session id so every iteration of a turn shares one backend session.
 *
 * This state uses the `stateless-loop` continuation mode: it is never valid
 * across separate user turns and is never persisted durably.
 */

import { parseJsonWith } from '../../../../lib/safe-parse';
import type { AgentTurnRequest } from '../../types';
import { getModelContextLimit } from '../context-policy';
import { createContinuationEnvelope } from '../continuation-envelope';
import type { ResponsesRequestPolicy } from './request-builder';

export interface ResponsesLoopState {
  /** Stable id shared by every iteration of one agentic turn. */
  sessionId: string;
  /** Conversation items accumulated within the current turn, in wire format. */
  loopItems: Array<Record<string, unknown>>;
}

/** Parses providerState into Responses loop state, or null when absent/invalid. */
export function parseResponsesLoopState(
  providerState: string | null | undefined,
  policy: ResponsesRequestPolicy
): ResponsesLoopState | null {
  return parseJsonWith(providerState, (parsed) => {
    if (parsed.provider !== policy.provider || parsed.mode !== 'stateless-loop') return null;
    if (typeof parsed.sessionId !== 'string' || !Array.isArray(parsed.loopItems)) return null;
    return {
      sessionId: parsed.sessionId,
      loopItems: parsed.loopItems as Array<Record<string, unknown>>,
    };
  });
}

/** Serializes the terminal providerState (continuation envelope + loop state). */
export function serializeResponsesTurnState(
  req: AgentTurnRequest,
  policy: ResponsesRequestPolicy,
  state: ResponsesLoopState,
  providerReportedInputTokens: number | undefined
): string {
  const envelope = createContinuationEnvelope(policy.provider, 'stateless-loop', req, undefined, {
    providerReportedInputTokens,
    contextLimit: getModelContextLimit(req.modelName),
  });
  return JSON.stringify({
    ...envelope,
    sessionId: state.sessionId,
    loopItems: state.loopItems,
  });
}
