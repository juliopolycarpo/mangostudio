/**
 * Turn-local loop state for the Anthropic stateless agentic tool loop.
 *
 * Anthropic has no server-side cursor: each turn replays DB history plus the
 * messages accumulated within the current turn (persisted in providerState).
 * This module owns parsing that state, assembling the request messages, and
 * minting the terminal providerState the orchestrator emits.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { parseJsonWith } from '../../../lib/safe-parse';
import { appendAttachmentFallbackNotes } from '../core/attachment-content';
import { getModelContextLimit } from '../core/context-policy';
import { createContinuationEnvelope } from '../core/continuation-envelope';
import type { AgentTurnRequest } from '../types';

/** Opaque loop-state stored in providerState during the tool-call loop. */
export interface AnthropicLoopState {
  provider: 'anthropic';
  loopMessages: Array<Anthropic.MessageParam>;
}

/** Parses providerState into Anthropic loop messages, or null when absent/invalid. */
export function parseAnthropicLoopState(
  providerState: string | null | undefined
): AnthropicLoopState | null {
  return parseJsonWith(providerState, (parsed) => {
    if (parsed.provider !== 'anthropic' || !Array.isArray(parsed.loopMessages)) return null;
    return parsed as unknown as AnthropicLoopState;
  });
}

/** Builds the current user prompt (with attachment fallback notes), or undefined. */
export function buildAnthropicProviderPrompt(req: AgentTurnRequest): string | undefined {
  if (req.prompt === undefined && (req.attachments?.length ?? 0) === 0) return undefined;
  return appendAttachmentFallbackNotes(req.prompt ?? '', req.attachments, req.modelCapabilities);
}

/**
 * Builds the new input message(s) for this iteration: tool results when
 * continuing a tool loop, otherwise the user prompt. Returns [] when neither
 * is present. Shared by request assembly and loop-state accumulation so the two
 * never drift.
 */
export function buildAnthropicCurrentInput(
  req: AgentTurnRequest,
  providerPrompt: string | undefined
): Anthropic.MessageParam[] {
  if (req.toolResults && req.toolResults.length > 0) {
    return [
      {
        role: 'user',
        content: req.toolResults.map((tr) => ({
          type: 'tool_result' as const,
          tool_use_id: tr.callId,
          content: tr.result,
          is_error: tr.isError ?? false,
        })),
      },
    ];
  }
  if (providerPrompt !== undefined) {
    return [{ role: 'user', content: providerPrompt }];
  }
  return [];
}

/** Assembles request messages: DB history + accumulated loop messages + current input. */
export function buildAnthropicRequestMessages(
  req: AgentTurnRequest,
  loopState: AnthropicLoopState | null,
  currentInput: Anthropic.MessageParam[]
): Anthropic.MessageParam[] {
  return [
    ...req.history.map(
      (turn): Anthropic.MessageParam => ({
        role: turn.role === 'ai' ? 'assistant' : 'user',
        content: turn.text,
      })
    ),
    ...(loopState?.loopMessages ?? []),
    ...currentInput,
  ];
}

/** Appends the current input and assistant reply to the accumulated loop messages. */
export function buildAnthropicLoopMessages(
  loopState: AnthropicLoopState | null,
  currentInput: Anthropic.MessageParam[],
  assistantContent: Anthropic.ContentBlock[]
): Anthropic.MessageParam[] {
  return [
    ...(loopState?.loopMessages ?? []),
    ...currentInput,
    ...(assistantContent.length > 0
      ? [{ role: 'assistant' as const, content: assistantContent }]
      : []),
  ];
}

/** Serializes the terminal providerState (continuation envelope + loop messages). */
export function serializeAnthropicTurnState(
  req: AgentTurnRequest,
  loopMessages: Anthropic.MessageParam[],
  providerReportedInputTokens: number | undefined
): string {
  const envelope = createContinuationEnvelope('anthropic', 'stateless-loop', req, undefined, {
    providerReportedInputTokens,
    contextLimit: getModelContextLimit(req.modelName),
  });
  return JSON.stringify({ ...envelope, loopMessages });
}
