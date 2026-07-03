/**
 * Responses protocol request construction.
 *
 * Keeps provider policy differences out of the stream loop: persistence,
 * continuation, instruction source, optional include fields, and unsupported
 * parameters are all resolved here.
 */

import type { MessagePart, ProviderType, ReasoningEffort } from '@mangostudio/shared/types';
import type OpenAI from 'openai';
import type {
  AgentTurnRequest,
  ModelCapabilities,
  ProviderRuntimeAttachment,
  TextGenerationRequest,
} from '../../types';
import {
  attachmentToDataUrl,
  getAttachmentSupportKind,
  isAttachmentSupportedByProvider,
  unsupportedAttachmentNotes,
} from '../attachment-content';
import { buildOpenAIResponsesReplay } from '../replay-builder';

const RESPONSES_ATTACHMENT_KINDS = ['image', 'pdf', 'text'] as const;

export type ResponsesContinuationPolicy = 'previous-response-id' | 'stateless-replay';
export type ResponsesReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
type ResponsesReasoningSummary = 'auto' | 'concise';

export interface ResponsesRequestPolicy {
  readonly provider: ProviderType;
  readonly store: boolean;
  readonly continuation: ResponsesContinuationPolicy;
  readonly instructions: 'system-prompt' | { pinned: string };
  readonly include?: readonly string[];
  readonly allowMaxOutputTokens: boolean;
  readonly extraHeaders?: () => Record<string, string>;
}

interface OpenAIUserContentRequest {
  attachments?: ProviderRuntimeAttachment[];
  modelCapabilities?: ModelCapabilities;
  prompt?: string;
}

export interface BuildResponsesCreateParamsOptions {
  model: string;
  input: Array<Record<string, unknown>>;
  policy: ResponsesRequestPolicy;
  instructions?: string;
  tools?: Array<Record<string, unknown>>;
  previousResponseId?: string | null;
  useReasoning?: boolean;
  reasoningEffort?: ResponsesReasoningEffort;
  reasoningSummary?: ResponsesReasoningSummary;
  textFormat?: Record<string, unknown>;
  maxOutputTokens?: number;
  enableCompaction?: boolean;
  providerCompactionThreshold?: number;
  contextLimit: number;
}

export interface BuildResponsesAgentTurnInputOptions {
  req: AgentTurnRequest;
  policy: ResponsesRequestPolicy;
  previousResponseId?: string | null;
}

export interface ResponsesRequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// SDK boundary casts — Responses API
//
// The SDK's ResponseInput and Tool types are complex unions that don't accept
// plain {role, content} objects or our tool definition shapes. These wrappers
// contain the single cast per pattern.
// ---------------------------------------------------------------------------

function toResponseInput(input: Array<Record<string, unknown>>): OpenAI.Responses.ResponseInput {
  return input as unknown as OpenAI.Responses.ResponseInput;
}

function toResponseTools(tools: Array<Record<string, unknown>>): OpenAI.Responses.Tool[] {
  return tools as unknown as OpenAI.Responses.Tool[];
}

// ---------------------------------------------------------------------------
// Responses create params builder
//
// Centralised construction so first call, cursor continuation, and replay
// retry all produce the same request shape.
// ---------------------------------------------------------------------------

function resolveProviderCompactionThreshold(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0.85;
  return Math.min(0.99, Math.max(0.5, value as number));
}

export function buildResponsesCreateParams(
  options: BuildResponsesCreateParamsOptions
): Record<string, unknown> {
  const {
    model,
    input,
    policy,
    instructions,
    tools,
    previousResponseId,
    useReasoning,
    reasoningEffort = 'medium',
    reasoningSummary = 'concise',
    textFormat,
    maxOutputTokens,
    enableCompaction = true,
    providerCompactionThreshold,
    contextLimit,
  } = options;

  const compactThreshold = Math.floor(
    contextLimit * resolveProviderCompactionThreshold(providerCompactionThreshold)
  );
  const canCompact =
    policy.continuation === 'previous-response-id' && previousResponseId && enableCompaction;
  const contextManagement = canCompact
    ? { context_management: [{ type: 'compaction', compact_threshold: compactThreshold }] }
    : {};
  const include = policy.include?.length ? { include: [...policy.include] } : {};
  const outputLimit =
    policy.allowMaxOutputTokens &&
    typeof maxOutputTokens === 'number' &&
    Number.isFinite(maxOutputTokens) &&
    maxOutputTokens > 0
      ? { max_output_tokens: Math.floor(maxOutputTokens) }
      : {};

  return {
    model,
    input: toResponseInput(input),
    ...(instructions?.trim() ? { instructions } : {}),
    ...(policy.continuation === 'previous-response-id' && previousResponseId
      ? { previous_response_id: previousResponseId }
      : {}),
    ...(tools && tools.length > 0 ? { tools: toResponseTools(tools) } : {}),
    store: policy.store,
    stream: true,
    ...include,
    ...(useReasoning ? { reasoning: { effort: reasoningEffort, summary: reasoningSummary } } : {}),
    ...outputLimit,
    ...contextManagement,
    ...(textFormat ?? {}),
  };
}

/**
 * Builds the `text.format` segment for structured output (JSON Schema) mode.
 * Returns an empty object when no structured output is requested.
 */
export function buildStructuredTextFormat(
  structured: { name: string; schema: Record<string, unknown>; strict?: boolean } | undefined
): Record<string, unknown> {
  if (!structured) return {};
  return {
    text: {
      format: {
        type: 'json_schema' as const,
        name: structured.name,
        schema: structured.schema,
        strict: structured.strict ?? true,
      },
    },
  };
}

export function resolveResponsesInstructions(
  systemPrompt: string | undefined,
  policy: ResponsesRequestPolicy
): string | undefined {
  if (policy.instructions === 'system-prompt') return systemPrompt;
  return policy.instructions.pinned;
}

export function buildResponsesRequestOptions(
  signal: AbortSignal | undefined,
  policy: ResponsesRequestPolicy
): ResponsesRequestOptions {
  const headers = policy.extraHeaders?.();
  return {
    ...(signal ? { signal } : {}),
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

export function buildResponsesTextInput(
  req: TextGenerationRequest
): Array<Record<string, unknown>> {
  return [
    ...req.history.map((msg) => ({
      role: msg.role === 'ai' ? 'assistant' : 'user',
      content: msg.text,
    })),
    ...buildResponsesCurrentUserInput(req),
  ];
}

export function buildResponsesInput(req: TextGenerationRequest): Array<Record<string, unknown>> {
  return buildResponsesTextInput(req);
}

export function buildResponsesCurrentUserInput(
  req: Pick<
    AgentTurnRequest | TextGenerationRequest,
    'prompt' | 'attachments' | 'modelCapabilities'
  >
): Record<string, unknown>[] {
  const userMessage = buildResponsesUserMessage(req);
  return userMessage ? [userMessage] : [];
}

export function buildResponsesAgentTurnInput({
  req,
  policy,
  previousResponseId,
}: BuildResponsesAgentTurnInputOptions): Array<Record<string, unknown>> {
  const toolOutputs =
    req.toolResults?.map((tr) => ({
      type: 'function_call_output',
      call_id: tr.callId,
      output: tr.result,
    })) ?? [];

  if (toolOutputs.length > 0) {
    if (policy.continuation === 'previous-response-id' && previousResponseId) {
      return toolOutputs;
    }
    return [...buildResponsesReplayForPolicy(req.history, policy), ...toolOutputs];
  }

  if (policy.continuation === 'previous-response-id' && previousResponseId) {
    return buildResponsesCurrentUserInput(req);
  }

  return [
    ...buildResponsesReplayForPolicy(req.history, policy),
    ...buildResponsesCurrentUserInput(req),
  ];
}

export function buildResponsesUserMessage(
  req: OpenAIUserContentRequest
): Record<string, unknown> | null {
  const attachments = req.attachments ?? [];
  if (attachments.length === 0) {
    return req.prompt !== undefined ? { role: 'user', content: req.prompt } : null;
  }

  const content: Record<string, unknown>[] = [];
  if (req.prompt?.trim()) content.push({ type: 'input_text', text: req.prompt });

  for (const attachment of attachments) {
    if (
      !isAttachmentSupportedByProvider(
        attachment,
        req.modelCapabilities,
        RESPONSES_ATTACHMENT_KINDS
      )
    ) {
      continue;
    }

    const supportKind = getAttachmentSupportKind(attachment);
    if (supportKind === 'image') {
      content.push({ type: 'input_image', image_url: attachmentToDataUrl(attachment) });
    } else if (supportKind === 'pdf' || supportKind === 'text') {
      content.push({
        type: 'input_file',
        filename: attachment.originalName,
        file_data: attachmentToDataUrl(attachment),
      });
    }
  }

  for (const note of unsupportedAttachmentNotes(
    attachments,
    req.modelCapabilities,
    RESPONSES_ATTACHMENT_KINDS
  )) {
    content.push({ type: 'input_text', text: note });
  }

  return { role: 'user', content };
}

export function normalizeResponsesReasoningEffort(
  effort: ReasoningEffort
): ResponsesReasoningEffort {
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') {
    return effort;
  }
  return 'high';
}

function buildResponsesReplayForPolicy(
  history: AgentTurnRequest['history'],
  policy: ResponsesRequestPolicy
): Array<Record<string, unknown>> {
  if (policy.continuation === 'stateless-replay') {
    return buildStatelessResponsesReplay(history);
  }
  return buildOpenAIResponsesReplay(history);
}

function buildStatelessResponsesReplay(
  history: AgentTurnRequest['history']
): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];

  for (const turn of history) {
    if (!turn.parts || turn.parts.length === 0) {
      items.push({
        role: turn.role === 'ai' ? 'assistant' : 'user',
        content: turn.text,
      });
      continue;
    }

    if (turn.role === 'user') {
      items.push({ role: 'user', content: turn.text });
      continue;
    }

    let textContent = '';
    const flushText = () => {
      if (!textContent) return;
      items.push({ role: 'assistant', content: textContent });
      textContent = '';
    };

    for (const part of turn.parts) {
      if (part.type === 'text') {
        textContent += part.text;
        continue;
      }

      if (part.type === 'thinking') {
        const encryptedContent = getEncryptedReasoningContent(part);
        if (encryptedContent) {
          flushText();
          items.push({ type: 'reasoning', encrypted_content: encryptedContent });
        }
        continue;
      }

      if (part.type === 'tool_call') {
        flushText();
        items.push({
          type: 'function_call',
          call_id: part.toolCallId,
          name: part.name,
          arguments: JSON.stringify(part.args),
        });
        continue;
      }

      if (part.type === 'tool_result') {
        flushText();
        items.push({
          type: 'function_call_output',
          call_id: part.toolCallId,
          output: part.content,
        });
      }
    }

    flushText();
  }

  return items;
}

function getEncryptedReasoningContent(part: Extract<MessagePart, { type: 'thinking' }>): string {
  const extended = part as Extract<MessagePart, { type: 'thinking' }> & {
    encrypted_content?: unknown;
    encryptedContent?: unknown;
  };
  if (typeof extended.encrypted_content === 'string') return extended.encrypted_content;
  if (typeof extended.encryptedContent === 'string') return extended.encryptedContent;
  return '';
}
