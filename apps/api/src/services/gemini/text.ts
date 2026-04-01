/**
 * Server-side Gemini text generation service.
 * Uses stateless context reconstruction from persisted message history.
 */

import { GoogleGenAI } from '@google/genai';
import type { Content } from '@google/genai';
import { getResolvedGeminiApiKey } from './secret';
import type { StreamingChunk, GenerationConfig } from '../providers/types';

/** A single streaming text chunk yielded during incremental generation. */
export interface TextStreamChunk {
  text: string;
  done: boolean;
}

/** A minimal message shape for context reconstruction. */
export interface TextContextMessage {
  role: 'user' | 'ai';
  text: string;
}

/**
 * Generates a text response using the Gemini API.
 * Reconstructs conversation context from persisted messages instead of using
 * in-memory SDK chat sessions, so it is fully stateless and replayable.
 *
 * @param history - Prior chat messages used as context (only text turns).
 * @param prompt - The current user prompt.
 * @param systemPrompt - Optional system instruction.
 * @param modelName - Gemini text model to use.
 * @returns The generated text response.
 */
export async function generateText(
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

  const ai = new GoogleGenAI({ apiKey });

  // Map persisted history into Gemini SDK contents
  const historyContents: Content[] = history.map((msg) => ({
    role: msg.role === 'ai' ? 'model' : 'user',
    parts: [{ text: msg.text }],
  }));

  // Append the current turn
  const contents: Content[] = [...historyContents, { role: 'user', parts: [{ text: prompt }] }];

  const config: Record<string, unknown> = {};
  if (systemPrompt && systemPrompt.trim()) {
    config.systemInstruction = systemPrompt;
  }

  const response = await ai.models.generateContent({
    model: modelName,
    contents,
    config,
  });

  if (response.promptFeedback?.blockReason) {
    throw new Error(`Prompt blocked: ${response.promptFeedback.blockReason}`);
  }

  const candidate = response.candidates?.[0];
  if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
    throw new Error(`Generation stopped: ${candidate.finishReason}`);
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
 *
 * @param history - Prior chat messages used as context (only text turns).
 * @param prompt - The current user prompt.
 * @param systemPrompt - Optional system instruction.
 * @param modelName - Gemini text model to use.
 * @yields Incremental text chunks; the last chunk has done:true and text:''.
 */
export async function* generateTextStream(
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
  const ai = new GoogleGenAI({ apiKey });

  const historyContents: Content[] = history.map((msg) => ({
    role: msg.role === 'ai' ? 'model' : 'user',
    parts: [{ text: msg.text }],
  }));

  const contents: Content[] = [...historyContents, { role: 'user', parts: [{ text: prompt }] }];

  const config: Record<string, unknown> = {};
  if (systemPrompt?.trim()) {
    config.systemInstruction = systemPrompt;
  }

  // Add thinking config based on enabled flag and effort level
  if (generationConfig?.thinkingEnabled) {
    const levelMap = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH' } as const;
    config.thinkingConfig = {
      includeThoughts: true,
      thinkingLevel: levelMap[generationConfig.reasoningEffort] ?? 'MEDIUM',
    };
  }

  const stream = await ai.models.generateContentStream({
    model: modelName,
    contents,
    config,
  });

  for await (const chunk of stream) {
    if (chunk.promptFeedback?.blockReason) {
      throw new Error(`Prompt blocked: ${chunk.promptFeedback.blockReason}`);
    }

    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
      throw new Error(`Generation stopped: ${candidate.finishReason}`);
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
      // Fallback for non-parts response shape
      yield { type: 'text', text: chunk.text, done: false };
    }
  }

  yield { type: 'text', text: '', done: true };
}
