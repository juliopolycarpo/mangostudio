/**
 * Gemini Interactions API agentic turn streaming.
 *
 * Stateful — uses `previous_interaction_id` for server-side continuation.
 * Degrades to full replay on safe cursor loss and aborts unsafe tool loops.
 */

import {
  attachmentToBase64,
  getAttachmentSupportKind,
  isAttachmentSupportedByProvider,
  unsupportedAttachmentNotes,
} from '../core/attachment-content';
import { getModelContextLimit } from '../core/context-policy';
import {
  computeSystemPromptHash,
  computeToolsetHash,
  createContinuationEnvelope,
  parseContinuationEnvelope,
  serializeContinuationEnvelope,
} from '../core/continuation-envelope';
import { logProviderDegrade } from '../core/continuation-logger';
import {
  buildGeminiInteractionsReplay,
  toGeminiFunctionResultPayload,
} from '../core/replay-builder';
import { toolDefsToGeminiInteractions } from '../core/tool-mapper';
import type { AgentEvent, AgentTurnRequest } from '../types';
import { createGeminiClient } from './client';
import {
  extractGeminiUsage,
  type InteractionSSEEvent,
  isFunctionCallStart,
  narrowGeminiDelta,
  toInteractionParams,
} from './normalizers';
import { buildInteractionsThinkingConfig } from './reasoning-config';
import { getResolvedGeminiApiKey } from './secret';

const GEMINI_INTERACTIONS_ATTACHMENT_KINDS = ['image', 'pdf', 'text'] as const;

/**
 * Opaque state persisted across turns for Gemini.
 * Only populated when the canonical continuation envelope is present and valid.
 */
interface GeminiInteractionState {
  provider: 'gemini';
  mode: 'interactions';
  interactionId: string;
  modelName: string;
  toolsetHash: string;
  systemPromptHash: string;
}

type GeminiInteractionInput = string | Array<Record<string, unknown>>;

interface BuildGeminiInteractionParamsOptions {
  input: GeminiInteractionInput;
  previousInteractionId?: string;
}

/**
 * Parses provider state strictly through the canonical continuation envelope.
 * Legacy state formats are not accepted — they bypass current safety validation
 * (cursor requirement, mode validation, system prompt hash checks) and are
 * treated as absent so the turn degrades to full replay instead.
 */
function parseGeminiState(providerState: string | null | undefined): GeminiInteractionState | null {
  const envelope = parseContinuationEnvelope(providerState);
  if (envelope?.provider === 'gemini' && envelope.cursor) {
    return {
      provider: 'gemini',
      mode: 'interactions',
      interactionId: envelope.cursor,
      modelName: envelope.modelName,
      toolsetHash: envelope.toolsetHash,
      systemPromptHash: envelope.systemPromptHash,
    };
  }
  return null;
}

function buildGeminiReplayInput(
  history: AgentTurnRequest['history'],
  input: GeminiInteractionInput
): GeminiInteractionInput | Array<Record<string, unknown>> {
  if (history.length === 0) {
    return input;
  }

  const historyTurns = buildGeminiInteractionsReplay(history);
  const currentTurn =
    typeof input === 'string' || input.length > 0 ? [{ role: 'user', content: input }] : [];

  return [...historyTurns, ...currentTurn];
}

function buildGeminiInteractionParams(
  req: AgentTurnRequest,
  options: BuildGeminiInteractionParamsOptions
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    model: req.modelName,
    input: options.previousInteractionId
      ? options.input
      : buildGeminiReplayInput(req.history, options.input),
    store: true,
    stream: true,
  };

  if (options.previousInteractionId) {
    params.previous_interaction_id = options.previousInteractionId;
  }
  if (req.systemPrompt?.trim()) {
    params.system_instruction = req.systemPrompt;
  }

  const toolDefs = req.toolDefinitions ?? [];
  if (toolDefs.length > 0) {
    params.tools = toolDefsToGeminiInteractions(toolDefs);
  }

  const thinkingConfig = req.generationConfig
    ? buildInteractionsThinkingConfig(
        req.modelName,
        req.generationConfig.thinkingEnabled,
        req.generationConfig.reasoningEffort
      )
    : undefined;
  if (thinkingConfig) {
    params.generation_config = thinkingConfig;
  }

  const structured = req.generationConfig?.structuredOutput;
  if (structured) {
    params.response_mime_type = 'application/json';
    params.response_format = structured.schema;
  }

  return params;
}

async function createGeminiInteractionStream(
  ai: ReturnType<typeof createGeminiClient>,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined
): Promise<AsyncIterable<InteractionSSEEvent>> {
  const interactions = ai.interactions as {
    create: (
      request: ReturnType<typeof toInteractionParams>,
      options?: { signal?: AbortSignal }
    ) => Promise<AsyncIterable<InteractionSSEEvent>>;
  };

  if (!signal) {
    return interactions.create(toInteractionParams(params));
  }

  return interactions.create(toInteractionParams(params), { signal });
}

/**
 * Streams a single agentic turn using the Gemini Interactions API.
 *
 * @param req     - Turn request.
 * @param client  - Optional injected client for tests. When absent, a real
 *                  client is created from the resolved API key.
 */
export async function* streamGeminiAgentTurn(
  req: AgentTurnRequest,
  client?: ReturnType<typeof createGeminiClient>
): AsyncIterable<AgentEvent> {
  const ai = client ?? createGeminiClient(await getResolvedGeminiApiKey(req.userId, req.modelName));

  const prevState = parseGeminiState(req.providerState);
  const toolDefs = req.toolDefinitions ?? [];
  const currentToolsetHash = computeToolsetHash(toolDefs);
  const currentSystemPromptHash = computeSystemPromptHash(req.systemPrompt);

  const canContinue =
    prevState !== null &&
    prevState.modelName === req.modelName &&
    prevState.toolsetHash === currentToolsetHash &&
    prevState.systemPromptHash === currentSystemPromptHash;

  let input: GeminiInteractionInput;
  if (req.toolResults && req.toolResults.length > 0) {
    input = req.toolResults.map((tr) => ({
      type: 'function_result' as const,
      call_id: tr.callId,
      name: tr.name,
      result: toGeminiFunctionResultPayload(tr.result, tr.isError),
      is_error: tr.isError ?? false,
    }));
  } else if (req.prompt !== undefined || (req.attachments?.length ?? 0) > 0) {
    input = buildGeminiInteractionInput(req);
  } else {
    yield { type: 'turn_error', error: 'No input for Gemini interaction' };
    return;
  }

  const interactionParams = buildGeminiInteractionParams(req, {
    input,
    previousInteractionId: canContinue ? prevState.interactionId : undefined,
  });

  try {
    const stream = await createGeminiInteractionStream(ai, interactionParams, req.signal);

    yield* processGeminiInteractionStream(stream, req);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);

    const isCursorError =
      canContinue &&
      (/not found/i.test(errMsg) ||
        /expired/i.test(errMsg) ||
        /invalid.*interaction/i.test(errMsg) ||
        /INVALID_ARGUMENT/.test(errMsg) ||
        /NOT_FOUND/.test(errMsg));

    if (isCursorError) {
      if (req.toolResults && req.toolResults.length > 0) {
        logProviderDegrade({
          provider: 'gemini',
          reason: 'cursor_error',
          reasonCode: 'tool_result_cursor_loss',
          toolResults: true,
        });

        yield {
          type: 'continuation_degraded',
          from: 'interactions',
          to: 'tool_loop_aborted',
          reason: 'cursor_error during tool-result continuation',
          reasonCode: 'tool_result_cursor_loss' as const,
        };
        yield {
          type: 'turn_error',
          error: 'Server-side continuation cursor expired during tool execution.',
        };
        return;
      }

      logProviderDegrade({
        provider: 'gemini',
        model: req.modelName,
        reason: 'cursor_expired',
        reasonCode: 'cursor_expired',
      });

      yield {
        type: 'continuation_degraded',
        from: 'interactions',
        to: 'replay',
        reason: `interaction_expired: ${errMsg}`,
        reasonCode: 'cursor_expired' as const,
      };

      try {
        const retryParams = buildGeminiInteractionParams(req, { input });
        const retryStream = await createGeminiInteractionStream(ai, retryParams, req.signal);

        yield* processGeminiInteractionStream(retryStream, req);
      } catch (retryErr: unknown) {
        yield {
          type: 'turn_error',
          error:
            retryErr instanceof Error ? retryErr.message : 'Gemini retry after cursor loss failed',
        };
      }
    } else {
      yield { type: 'turn_error', error: errMsg };
    }
  }
}

function buildGeminiInteractionInput(req: AgentTurnRequest): GeminiInteractionInput {
  const attachments = req.attachments ?? [];
  if (attachments.length === 0) return req.prompt ?? '';

  const input: Record<string, unknown>[] = [];
  if (req.prompt?.trim()) input.push({ type: 'text', text: req.prompt });

  for (const attachment of attachments) {
    if (
      !isAttachmentSupportedByProvider(
        attachment,
        req.modelCapabilities,
        GEMINI_INTERACTIONS_ATTACHMENT_KINDS
      )
    ) {
      continue;
    }

    const supportKind = getAttachmentSupportKind(attachment);
    if (supportKind === 'image') {
      input.push({
        type: 'image',
        data: attachmentToBase64(attachment),
        mime_type: attachment.mimeType,
      });
    } else if (supportKind === 'pdf' || supportKind === 'text') {
      input.push({
        type: 'document',
        data: attachmentToBase64(attachment),
        mime_type: attachment.mimeType,
        name: attachment.originalName,
      });
    }
  }

  for (const note of unsupportedAttachmentNotes(
    attachments,
    req.modelCapabilities,
    GEMINI_INTERACTIONS_ATTACHMENT_KINDS
  )) {
    input.push({ type: 'text', text: note });
  }

  return input;
}

/**
 * Processes a Gemini Interactions streaming response and yields AgentEvents.
 * Used by both the primary path and the cursor-loss retry path.
 */
export async function* processGeminiInteractionStream(
  stream: AsyncIterable<InteractionSSEEvent>,
  req: AgentTurnRequest
): AsyncIterable<AgentEvent> {
  const activeCalls = new Map<
    number,
    { id: string; name: string; args: Record<string, unknown>; started: boolean }
  >();
  let interactionId: string | undefined;
  let providerReportedInputTokens: number | undefined;

  for await (const event of stream) {
    if (event.event_type === 'content.start') {
      if (isFunctionCallStart(event.content)) {
        const callId =
          event.content.id || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const name = event.content.name;
        const callEntry = { id: callId, name, args: {}, started: false };
        activeCalls.set(event.index, callEntry);
        if (name) {
          callEntry.started = true;
          yield { type: 'tool_call_started', callId, name };
        }
      }
    } else if (event.event_type === 'content.delta') {
      const nd = narrowGeminiDelta(event.delta);
      if (nd.kind === 'thought_summary') {
        if (nd.text) {
          yield { type: 'reasoning_delta', text: nd.text };
        }
      } else if (nd.kind === 'text') {
        yield { type: 'assistant_text_delta', text: nd.text };
      } else if (nd.kind === 'function_call') {
        const call = activeCalls.get(event.index);
        if (call) {
          if (nd.name && !call.name) call.name = nd.name;
          if (!call.started && call.name) {
            call.started = true;
            yield { type: 'tool_call_started', callId: call.id, name: call.name };
          }
          Object.assign(call.args, nd.args);
          const argChunk = JSON.stringify(nd.args);
          yield { type: 'tool_call_arguments_delta', callId: call.id, delta: argChunk };
        }
      } else if (nd.kind !== 'thought_signature') {
        console.warn('[gemini-interactions] unknown delta type:', JSON.stringify(event.delta));
      }
    } else if (event.event_type === 'content.stop') {
      const call = activeCalls.get(event.index);
      if (call) {
        yield {
          type: 'tool_call_completed',
          callId: call.id,
          name: call.name,
          arguments: JSON.stringify(call.args),
        };
        activeCalls.delete(event.index);
      }
    } else if (event.event_type === 'interaction.complete') {
      interactionId = event.interaction.id;
      const gu = extractGeminiUsage(event.interaction.usage);
      if (gu.totalInputTokens > 0) providerReportedInputTokens = gu.totalInputTokens;
      if (gu.cachedTokens > 0 && gu.totalInputTokens > 0) {
        console.warn(
          `[prefix-cache][gemini] ${gu.cachedTokens}/${gu.totalInputTokens} input tokens from cache (${Math.round((gu.cachedTokens / gu.totalInputTokens) * 100)}%)`
        );
      }
    } else if (event.event_type === 'interaction.start') {
      interactionId = event.interaction.id;
    }
  }

  if (!interactionId) {
    yield { type: 'turn_error', error: 'No interaction ID returned from Gemini streaming' };
    return;
  }

  const envelope = createContinuationEnvelope('gemini', 'interactions', req, interactionId, {
    providerReportedInputTokens,
    contextLimit: getModelContextLimit(req.modelName),
  });

  yield { type: 'turn_completed', providerState: serializeContinuationEnvelope(envelope) };
}
