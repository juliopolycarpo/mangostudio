/**
 * OpenAI-compatible SDK client factory.
 * Creates an OpenAI client pointed at a custom base URL.
 */

import OpenAI from 'openai';

export function createCompatibleClient(apiKey: string, baseUrl: string): OpenAI {
  return new OpenAI({ apiKey, baseURL: baseUrl });
}
