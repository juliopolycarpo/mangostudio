import type OpenAI from 'openai';
import { extractReasoningChunks } from '../openai/normalizers';
import type { StreamingChunk, TextGenerationRequest, TextGenerationResult } from '../types';
import { buildDeepSeekRequestBody } from './message-mapper';
import { buildDeepSeekChatMessages, toErrorMessage } from './normalizers';

const GENERATION_TIMEOUT_MS = 120_000;

type DeepSeekChatClient = Pick<OpenAI, 'chat'>;

interface DeepSeekTextOptions {
  /** Deadline for the whole response, not just its first byte. */
  readonly timeoutMs?: number;
}

/**
 * Streams a plain (tool-less) DeepSeek chat reply as text and thinking chunks.
 *
 * Failures end the stream with one `error` chunk instead of throwing, and the
 * caller's abort ends it quietly with the usual `done` chunk.
 *
 * // Usage: for await (const chunk of streamDeepSeekText(client, req)) render(chunk);
 */
export async function* streamDeepSeekText(
  client: DeepSeekChatClient,
  req: TextGenerationRequest,
  options: DeepSeekTextOptions = {}
): AsyncIterable<StreamingChunk> {
  const timeoutMs = options.timeoutMs ?? GENERATION_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = req.signal ? AbortSignal.any([req.signal, deadline]) : deadline;
  const body = buildDeepSeekRequestBody({
    modelName: req.modelName,
    messages: buildDeepSeekChatMessages(req),
    thinkingEnabled: req.generationConfig?.thinkingEnabled ?? false,
    reasoningEffort: req.generationConfig?.reasoningEffort,
  });

  try {
    const stream = await client.chat.completions.create(
      body as unknown as OpenAI.ChatCompletionCreateParamsStreaming,
      { signal }
    );
    for await (const chunk of stream) {
      if (req.signal?.aborted) break;
      yield* toStreamingChunks(chunk);
    }
  } catch (error) {
    if (!req.signal?.aborted) {
      const content = deadline.aborted
        ? `DeepSeek response exceeded the ${timeoutMs} ms deadline.`
        : toErrorMessage(error, 'DeepSeek stream failed');
      yield { type: 'error', content, done: true };
      return;
    }
  }

  yield { type: 'text', text: '', done: true };
}

/**
 * Collects a DeepSeek chat reply into one string, leaving out its reasoning.
 * Throws on failure or abort; an empty reply is returned for the caller to judge.
 *
 * // Usage: const { text } = await generateDeepSeekText(client, req);
 */
export async function generateDeepSeekText(
  client: DeepSeekChatClient,
  req: TextGenerationRequest,
  options: DeepSeekTextOptions = {}
): Promise<TextGenerationResult> {
  let text = '';
  for await (const chunk of streamDeepSeekText(client, req, options)) {
    if (chunk.type === 'error') throw new Error(chunk.content);
    if (chunk.type === 'text') text += chunk.text ?? '';
  }

  req.signal?.throwIfAborted();
  return { text };
}

function* toStreamingChunks(chunk: OpenAI.ChatCompletionChunk): Generator<StreamingChunk> {
  const delta = chunk.choices[0]?.delta as Record<string, unknown> | undefined;
  if (!delta) return;

  for (const reasoning of extractReasoningChunks(delta)) {
    yield { type: 'thinking', text: reasoning, done: false };
  }
  if (typeof delta.content === 'string' && delta.content) {
    yield { type: 'text', text: delta.content, done: false };
  }
}
