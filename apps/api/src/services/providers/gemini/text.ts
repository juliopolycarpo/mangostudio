/**
 * Gemini text generation service (non-agentic).
 * Uses the generateContent / generateContentStream APIs via stateless context replay.
 */

import type { Content, Part } from '@google/genai';
import {
  attachmentToBase64,
  getAttachmentSupportKind,
  isAttachmentSupportedByProvider,
  unsupportedAttachmentNotes,
} from '../core/attachment-content';
import type {
  GenerationConfig,
  ModelCapabilities,
  ProviderRuntimeAttachment,
  StreamingChunk,
  TextContextMessage,
} from '../types';
import { createGeminiClient } from './client';
import { buildTextThinkingConfig } from './reasoning-config';
import { getResolvedGeminiApiKey } from './secret';

const GEMINI_CONTENT_ATTACHMENT_KINDS = ['image', 'pdf', 'text'] as const;

interface GeminiTextAttachmentOptions {
  attachments?: ProviderRuntimeAttachment[];
  modelCapabilities?: ModelCapabilities;
}

/**
 * Generates a text response using the Gemini API.
 * Reconstructs conversation context from persisted messages.
 */
export async function generateGeminiText(
  userId: string,
  history: TextContextMessage[],
  prompt: string,
  systemPrompt?: string,
  modelName?: string,
  attachmentOptions: GeminiTextAttachmentOptions = {},
  client?: ReturnType<typeof createGeminiClient>
): Promise<string> {
  if (!modelName) {
    throw new Error('No Gemini text model was provided.');
  }

  const ai = client ?? createGeminiClient(await getResolvedGeminiApiKey(userId, modelName));

  const historyContents: Content[] = history.map((msg) => ({
    role: msg.role === 'ai' ? 'model' : 'user',
    parts: [{ text: msg.text }],
  }));

  const contents: Content[] = [
    ...historyContents,
    { role: 'user', parts: buildGeminiUserParts(prompt, attachmentOptions) },
  ];

  const config: Record<string, unknown> = {};
  if (systemPrompt && systemPrompt.trim()) {
    config.systemInstruction = systemPrompt;
  }

  const response = await ai.models.generateContent({ model: modelName, contents, config });

  if (response.promptFeedback?.blockReason) {
    throw new Error(`Prompt blocked: ${response.promptFeedback.blockReason}`);
  }

  const candidate = response.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (finishReason && String(finishReason) !== 'STOP') {
    throw new Error(`Generation stopped: ${finishReason}`);
  }

  const text = response.text;
  if (!text) {
    console.error('[gemini-text] Full response:', JSON.stringify(response, null, 2));
    throw new Error('No text returned from Gemini');
  }

  return text;
}

/**
 * Streams a text response using the Gemini API.
 * Yields incremental chunks and a final sentinel with done:true.
 */
export async function* generateGeminiTextStream(
  userId: string,
  history: TextContextMessage[],
  prompt: string,
  systemPrompt?: string,
  modelName?: string,
  generationConfig?: GenerationConfig,
  attachmentOptions: GeminiTextAttachmentOptions = {},
  client?: ReturnType<typeof createGeminiClient>
): AsyncGenerator<StreamingChunk> {
  if (!modelName) {
    throw new Error('No Gemini text model was provided.');
  }

  const ai = client ?? createGeminiClient(await getResolvedGeminiApiKey(userId, modelName));

  const historyContents: Content[] = history.map((msg) => ({
    role: msg.role === 'ai' ? 'model' : 'user',
    parts: [{ text: msg.text }],
  }));

  const contents: Content[] = [
    ...historyContents,
    { role: 'user', parts: buildGeminiUserParts(prompt, attachmentOptions) },
  ];

  const config: Record<string, unknown> = {};
  if (systemPrompt?.trim()) {
    config.systemInstruction = systemPrompt;
  }

  if (modelName && generationConfig) {
    const thinkingConfig = buildTextThinkingConfig(
      modelName,
      generationConfig.thinkingEnabled,
      generationConfig.reasoningEffort
    );
    if (thinkingConfig) {
      config.thinkingConfig = thinkingConfig;
    }

    if (generationConfig.structuredOutput) {
      config.responseMimeType = 'application/json';
      config.responseSchema = generationConfig.structuredOutput.schema;
    }
  }

  const stream = await ai.models.generateContentStream({ model: modelName, contents, config });

  for await (const chunk of stream) {
    if (chunk.promptFeedback?.blockReason) {
      throw new Error(`Prompt blocked: ${chunk.promptFeedback.blockReason}`);
    }

    const candidate = chunk.candidates?.[0];
    const finishReason = candidate?.finishReason;
    if (finishReason && String(finishReason) !== 'STOP') {
      throw new Error(`Generation stopped: ${finishReason}`);
    }

    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if ((part as { thought?: boolean }).thought && part.text) {
          yield { type: 'thinking', text: part.text, done: false };
        } else if (part.text) {
          yield { type: 'text', text: part.text, done: false };
        }
      }
    } else if (chunk.text) {
      yield { type: 'text', text: chunk.text, done: false };
    }
  }

  yield { type: 'text', text: '', done: true };
}

function buildGeminiUserParts(prompt: string, options: GeminiTextAttachmentOptions): Part[] {
  const attachments = options.attachments ?? [];
  if (attachments.length === 0) return [{ text: prompt }];

  const parts: Part[] = [];
  if (prompt.trim()) parts.push({ text: prompt });

  for (const attachment of attachments) {
    if (
      !isAttachmentSupportedByProvider(
        attachment,
        options.modelCapabilities,
        GEMINI_CONTENT_ATTACHMENT_KINDS
      )
    ) {
      continue;
    }

    const supportKind = getAttachmentSupportKind(attachment);
    if (supportKind === 'image' || supportKind === 'pdf' || supportKind === 'text') {
      parts.push({
        inlineData: {
          data: attachmentToBase64(attachment),
          displayName: attachment.originalName,
          mimeType: attachment.mimeType,
        },
      });
    }
  }

  for (const note of unsupportedAttachmentNotes(
    attachments,
    options.modelCapabilities,
    GEMINI_CONTENT_ATTACHMENT_KINDS
  )) {
    parts.push({ text: note });
  }

  return parts.length > 0 ? parts : [{ text: prompt }];
}
