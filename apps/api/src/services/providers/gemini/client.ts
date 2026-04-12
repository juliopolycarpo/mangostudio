/**
 * Gemini SDK client factory.
 * Creates a GoogleGenAI instance from an API key.
 */

import { GoogleGenAI } from '@google/genai';

export function createGeminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({ apiKey });
}
