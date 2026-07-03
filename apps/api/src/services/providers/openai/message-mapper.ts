/**
 * OpenAI-format message builders.
 * Converts internal request shapes into OpenAI Chat Completions and Responses API inputs.
 */

import type OpenAI from 'openai';
import {
  attachmentToDataUrl,
  isAttachmentSupportedByProvider,
  unsupportedAttachmentNotes,
} from '../core/attachment-content';

export {
  buildResponsesInput,
  buildResponsesUserMessage as buildOpenAIResponsesUserMessage,
} from '../core/responses-protocol/request-builder';

import type { ModelCapabilities, ProviderRuntimeAttachment, TextGenerationRequest } from '../types';

const OPENAI_CHAT_ATTACHMENT_KINDS = ['image'] as const;

/**
 * Builds a Chat Completions messages array from a TextGenerationRequest.
 * Prepends system prompt when present; maps history + prompt.
 */
export function buildChatMessages(req: TextGenerationRequest): OpenAI.ChatCompletionMessageParam[] {
  return [
    ...(req.systemPrompt?.trim() ? [{ role: 'system' as const, content: req.systemPrompt }] : []),
    ...req.history.map(
      (msg): OpenAI.ChatCompletionMessageParam => ({
        role: msg.role === 'ai' ? 'assistant' : 'user',
        content: msg.text,
      })
    ),
    buildOpenAIChatUserMessage(req),
  ];
}

function buildOpenAIChatUserMessage(req: TextGenerationRequest): OpenAI.ChatCompletionMessageParam {
  const attachments = req.attachments ?? [];
  if (attachments.length === 0) {
    return { role: 'user', content: req.prompt };
  }

  const content: Record<string, unknown>[] = [];
  if (req.prompt.trim()) content.push({ type: 'text', text: req.prompt });

  for (const attachment of supportedChatImageAttachments(attachments, req.modelCapabilities)) {
    content.push({
      type: 'image_url',
      image_url: { url: attachmentToDataUrl(attachment) },
    });
  }

  for (const note of unsupportedAttachmentNotes(
    attachments,
    req.modelCapabilities,
    OPENAI_CHAT_ATTACHMENT_KINDS
  )) {
    content.push({ type: 'text', text: note });
  }

  return { role: 'user', content } as unknown as OpenAI.ChatCompletionMessageParam;
}

function supportedChatImageAttachments(
  attachments: readonly ProviderRuntimeAttachment[],
  capabilities: ModelCapabilities | undefined
): ProviderRuntimeAttachment[] {
  return attachments.filter((attachment) =>
    isAttachmentSupportedByProvider(attachment, capabilities, OPENAI_CHAT_ATTACHMENT_KINDS)
  );
}
