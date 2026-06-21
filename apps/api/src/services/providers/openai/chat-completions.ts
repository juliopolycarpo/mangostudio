import type OpenAI from 'openai';
import type { StreamingChunk, TextGenerationRequest, TextGenerationResult } from '../types';
import { buildChatMessages } from './message-mapper';

export async function generateChatCompletionText(
  client: OpenAI,
  req: TextGenerationRequest,
  emptyTextMessage: string
): Promise<TextGenerationResult> {
  const completion = await client.chat.completions.create(
    { model: req.modelName, messages: buildChatMessages(req), stream: false },
    { signal: req.signal }
  );

  const text = completion.choices[0]?.message?.content ?? '';
  if (!text) throw new Error(emptyTextMessage);
  return { text };
}

export async function* streamChatCompletionText(
  client: OpenAI,
  req: TextGenerationRequest
): AsyncIterable<StreamingChunk> {
  const stream = await client.chat.completions.create(
    { model: req.modelName, messages: buildChatMessages(req), stream: true },
    { signal: req.signal }
  );

  for await (const chunk of stream) {
    if (req.signal?.aborted) break;
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield { type: 'text', text: delta, done: false };
  }
  yield { type: 'text', text: '', done: true };
}
