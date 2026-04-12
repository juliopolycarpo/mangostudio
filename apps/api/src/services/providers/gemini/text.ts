/**
 * Gemini text generation service (non-agentic).
 * Uses the generateContent / generateContentStream APIs via stateless context replay.
 */

import type { Content } from '@google/genai';
import { getResolvedGeminiApiKey } from './secret';
import { createGeminiClient } from './client';
import type { StreamingChunk, GenerationConfig, TextContextMessage } from '../types';

/**
 * Generates a text response using the Gemini API.
 * Reconstructs conversation context from persisted messages.
 */
export async function generateGeminiText(
  userId: string,
  history: TextContextMessage[],
  prompt: string,
  systemPrompt?: string,
  modelName?: string
): Promise<string> {
  if (!modelName) {
    throw new Error('No Gemini text model was provided.');
  }

  const apiKey = await getResolvedGeminiApiKey(userId, modelName);
  const ai = createGeminiClient(apiKey);

  const historyContents: Content[] = history.map((msg) => ({
    role: msg.role === 'ai' ? 'model' : 'user',
    parts: [{ text: msg.text }],
  }));

  const contents: Content[] = [...historyContents, { role: 'user', parts: [{ text: prompt }] }];

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
  generationConfig?: GenerationConfig
): AsyncGenerator<StreamingChunk> {
  if (!modelName) {
    throw new Error('No Gemini text model was provided.');
  }

  const apiKey = await getResolvedGeminiApiKey(userId, modelName);
  const ai = createGeminiClient(apiKey);

  const historyContents: Content[] = history.map((msg) => ({
    role: msg.role === 'ai' ? 'model' : 'user',
    parts: [{ text: msg.text }],
  }));

  const contents: Content[] = [...historyContents, { role: 'user', parts: [{ text: prompt }] }];

  const config: Record<string, unknown> = {};
  if (systemPrompt?.trim()) {
    config.systemInstruction = systemPrompt;
  }

  if (generationConfig?.thinkingEnabled) {
    const levelMap = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH' } as const;
    config.thinkingConfig = {
      includeThoughts: true,
      thinkingLevel: levelMap[generationConfig.reasoningEffort] ?? 'MEDIUM',
    };
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
