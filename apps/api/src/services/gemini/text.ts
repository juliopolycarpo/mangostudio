/**
 * Server-side Gemini text generation service.
 * Uses stateless context reconstruction from persisted message history.
 */

import { GoogleGenAI } from '@google/genai';
import type { Content } from '@google/genai';
import { getResolvedGeminiApiKey } from './secret';

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
