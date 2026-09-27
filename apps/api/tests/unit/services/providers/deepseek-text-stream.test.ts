import { describe, expect, it } from 'bun:test';
import {
  generateDeepSeekText,
  streamDeepSeekText,
} from '../../../../src/services/providers/deepseek/text-stream';
import type {
  StreamingChunk,
  TextGenerationRequest,
} from '../../../../src/services/providers/types';
import {
  chainChunks,
  createFakeChatCompletionsClient,
  stopChunk,
  textDeltaChunk,
} from '../../../support/providers/fake-chat-completions';
import { reasoningDeltaChunk } from '../../../support/providers/fake-deepseek-stream';

type Params = Record<string, unknown>;
type FakeClient = Parameters<typeof streamDeepSeekText>[0];

const baseReq: TextGenerationRequest = {
  userId: 'test-user',
  history: [],
  prompt: 'Hello',
  systemPrompt: 'You are concise.',
  modelName: 'deepseek-v4-flash',
};

/** A client whose single completion yields `chunks`, recording what it was asked. */
function createRecordingClient(chunks: () => AsyncIterable<Params>): {
  client: FakeClient;
  calls: Params[];
} {
  const calls: Params[] = [];
  const client = createFakeChatCompletionsClient((params) => {
    calls.push(params);
    return Promise.resolve(chunks());
  });
  return { client: client as unknown as FakeClient, calls };
}

/** A client whose completion never resolves until its signal aborts. */
function createHangingClient(): FakeClient {
  const client = createFakeChatCompletionsClient(
    (_params, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('Request was aborted.')));
      })
  );
  return client as unknown as FakeClient;
}

/** A client whose completion rejects with `message`. */
function createFailingClient(message: string): FakeClient {
  const client = createFakeChatCompletionsClient(() => Promise.reject(new Error(message)));
  return client as unknown as FakeClient;
}

async function collect(stream: AsyncIterable<StreamingChunk>): Promise<StreamingChunk[]> {
  const chunks: StreamingChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe('streamDeepSeekText', () => {
  it('streams reasoning as thinking and content as text, then a done chunk', async () => {
    const { client } = createRecordingClient(() =>
      chainChunks(reasoningDeltaChunk('Let me think'), textDeltaChunk('Hi!'), stopChunk())
    );

    expect(await collect(streamDeepSeekText(client, baseReq))).toEqual([
      { type: 'thinking', text: 'Let me think', done: false },
      { type: 'text', text: 'Hi!', done: false },
      { type: 'text', text: '', done: true },
    ]);
  });

  it('asks DeepSeek for thinking at its normalized effort with the system prompt first', async () => {
    const { client, calls } = createRecordingClient(() => chainChunks(stopChunk()));
    const req: TextGenerationRequest = {
      ...baseReq,
      generationConfig: { thinkingEnabled: true, reasoningEffort: 'xhigh' },
    };

    await collect(streamDeepSeekText(client, req));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: 'deepseek-v4-flash',
      stream: true,
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    });
    expect(calls[0]?.tools).toBeUndefined();
    const messages = calls[0]?.messages as Array<{ role: string }>;
    expect(messages.map((message) => message.role)).toEqual(['system', 'user']);
  });

  it('ends with one error chunk carrying the API failure instead of throwing', async () => {
    const chunks = await collect(
      streamDeepSeekText(createFailingClient('401 invalid api key'), baseReq)
    );

    expect(chunks).toEqual([{ type: 'error', content: '401 invalid api key', done: true }]);
  });

  it('reports the deadline, not the abort, when the response runs out of time', async () => {
    const chunks = await collect(
      streamDeepSeekText(createHangingClient(), baseReq, { timeoutMs: 10 })
    );

    expect(chunks).toEqual([
      { type: 'error', content: 'DeepSeek response exceeded the 10 ms deadline.', done: true },
    ]);
  });

  it('ends quietly with a done chunk when the caller aborts', async () => {
    const controller = new AbortController();
    const stream = streamDeepSeekText(createHangingClient(), {
      ...baseReq,
      signal: controller.signal,
    });
    queueMicrotask(() => controller.abort());

    expect(await collect(stream)).toEqual([{ type: 'text', text: '', done: true }]);
  });
});

describe('generateDeepSeekText', () => {
  it('joins the text deltas and leaves the reasoning out', async () => {
    const { client } = createRecordingClient(() =>
      chainChunks(
        reasoningDeltaChunk('Planning'),
        textDeltaChunk('Hello, '),
        textDeltaChunk('world'),
        stopChunk()
      )
    );

    expect(await generateDeepSeekText(client, baseReq)).toEqual({ text: 'Hello, world' });
  });

  it('throws the API failure', async () => {
    await expect(
      generateDeepSeekText(createFailingClient('429 rate limited'), baseReq)
    ).rejects.toThrow('429 rate limited');
  });

  it('throws when the caller aborts instead of returning a partial reply', async () => {
    const controller = new AbortController();
    const pending = generateDeepSeekText(createHangingClient(), {
      ...baseReq,
      signal: controller.signal,
    });
    controller.abort(new Error('caller aborted'));

    await expect(pending).rejects.toThrow('caller aborted');
  });
});
