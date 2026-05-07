/**
 * OpenAI-format message builders.
 * Converts internal request shapes into OpenAI Chat Completions and Responses API inputs.
 */

import type OpenAI from 'openai';
import type {
  AgentTurnRequest,
  ModelCapabilities,
  ProviderRuntimeAttachment,
  TextGenerationRequest,
} from '../types';
import {
  attachmentToDataUrl,
  getAttachmentSupportKind,
  isAttachmentSupportedByProvider,
  unsupportedAttachmentNotes,
} from '../core/attachment-content';

const OPENAI_CHAT_ATTACHMENT_KINDS = ['image'] as const;
const OPENAI_RESPONSES_ATTACHMENT_KINDS = ['image', 'pdf', 'text'] as const;

type OpenAIUserContentRequest = Pick<
  TextGenerationRequest | AgentTurnRequest,
  'attachments' | 'modelCapabilities'
> & {
  prompt?: string;
};

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

/**
 * Builds the `input` array for the Responses API from a TextGenerationRequest.
 * Maps history + current prompt into the shape expected by responses.create().
 */
export function buildResponsesInput(req: TextGenerationRequest): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];

  for (const msg of req.history) {
    messages.push({
      role: msg.role === 'ai' ? 'assistant' : 'user',
      content: msg.text,
    });
  }

  const userMessage = buildOpenAIResponsesUserMessage(req);
  if (userMessage) messages.push(userMessage);
  return messages;
}

export function buildOpenAIResponsesUserMessage(
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
        OPENAI_RESPONSES_ATTACHMENT_KINDS
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
    OPENAI_RESPONSES_ATTACHMENT_KINDS
  )) {
    content.push({ type: 'input_text', text: note });
  }

  return { role: 'user', content };
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
