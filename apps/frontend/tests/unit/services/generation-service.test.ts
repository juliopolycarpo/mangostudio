/**
 * Unit tests for the generation service wrappers that survive the client cleanup:
 * `respondTextStream` (the active streaming path), `generateImage`, and
 * `uploadReferenceImage`. The non-streaming `respondText` wrapper was removed,
 * so its behavior is intentionally not exercised here.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import type { GenerateImageResponse } from '@mangostudio/shared';
import type { RespondStreamBody } from '@mangostudio/shared/generation';
import { en } from '@mangostudio/shared/i18n';
import type { StreamChunk } from '@mangostudio/shared/streaming';
import type * as ApiClient from '../../../src/lib/api-client';
import type { GenerateImageRequest } from '../../../src/services/generation-service';

// Eden Treaty's generic types are too strict for jest.fn() mocks, so the factory is cast via unknown.
// `vi.hoisted` existed because `vi.mock` is hoisted above the file's own
// statements. `mock.module` is not hoisted, so plain consts are enough.
const mockGeneratePost = jest.fn();
const mockUploadPost = jest.fn();
const mockRecoveryCancelPost = jest.fn();
const mockRecoveryDismissPost = jest.fn();
const mockRecoveryMessages = jest.fn(() => ({
  recovery: {
    cancel: { post: mockRecoveryCancelPost },
    dismiss: { post: mockRecoveryDismissPost },
  },
}));
const mockRecoveryChats = jest.fn(() => ({ messages: mockRecoveryMessages }));

mock.module('../../../src/lib/api-client', () => ({
  client: {
    api: {
      generate: { post: mockGeneratePost },
      upload: { post: mockUploadPost },
      chats: mockRecoveryChats,
    },
  } as unknown as typeof ApiClient,
}));

// Below the mock, never as a static import: those are evaluated first and the
// service would bind the real API client.
const {
  cancelInterruptedTurn,
  dismissInterruptedTurn,
  generateImage,
  respondTextStream,
  startExternalReviewStream,
  uploadReferenceImage,
} = await import('../../../src/services/generation-service');

const STREAM_PATH = '/api/respond/stream';

function makeImageRequest(overrides: Partial<GenerateImageRequest> = {}): GenerateImageRequest {
  return { chatId: 'chat-1', model: 'gpt-image-1', prompt: 'a mango', ...overrides };
}

function makeRequest(overrides: Partial<RespondStreamBody> = {}): RespondStreamBody {
  return {
    chatId: 'chat-1',
    prompt: 'Hello there',
    toolIntent: 'auto',
    ...overrides,
  } as RespondStreamBody;
}

/** Builds an SSE Response whose body streams the given pieces in order. */
function streamingResponse(pieces: string[], init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
  return new Response(body, { status: 200, ...init });
}

function collectChunks() {
  const chunks: StreamChunk[] = [];
  return { chunks, onChunk: (chunk: StreamChunk) => chunks.push(chunk) };
}

describe('turn recovery actions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls the message-scoped cancel and dismiss endpoints', async () => {
    mockRecoveryCancelPost.mockResolvedValue({ data: {}, error: null });
    mockRecoveryDismissPost.mockResolvedValue({ data: {}, error: null });

    await cancelInterruptedTurn('chat-1', 'message-1');
    await dismissInterruptedTurn('chat-1', 'message-1');

    expect(mockRecoveryChats).toHaveBeenCalledWith({ id: 'chat-1' });
    expect(mockRecoveryMessages).toHaveBeenCalledWith({ messageId: 'message-1' });
    expect(mockRecoveryCancelPost).toHaveBeenCalledTimes(1);
    expect(mockRecoveryDismissPost).toHaveBeenCalledTimes(1);
  });

  it('surfaces a recovery action error from the API', async () => {
    mockRecoveryCancelPost.mockResolvedValue({
      data: null,
      error: { value: { error: 'Turn already completed' } },
    });

    await expect(cancelInterruptedTurn('chat-1', 'message-1')).rejects.toThrow(
      'Turn already completed'
    );
  });
});

describe('respondTextStream', () => {
  let fetchMock: ReturnType<typeof jest.fn>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    fetchMock = jest.fn();
    // `vi.stubGlobal` / `vi.unstubAllGlobals` do not exist on Bun; the original
    // is captured and put back by hand. `bun.setup.ts` also reinstates its
    // unreachable `fetch` after every test, so a missed restore cannot leak.
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends a POST to the stream endpoint with the serialized request and signal', async () => {
    fetchMock.mockResolvedValue(
      streamingResponse(['data: {"type":"text","text":"hi","done":false}\n'])
    );
    const controller = new AbortController();
    const { onChunk } = collectChunks();

    await respondTextStream(makeRequest({ prompt: 'Trace me' }), onChunk, controller.signal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(STREAM_PATH);
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      signal: controller.signal,
    });
    expect(JSON.parse(init.body)).toMatchObject({ prompt: 'Trace me', chatId: 'chat-1' });
  });

  it('parses each SSE data event and forwards it to onChunk in order', async () => {
    fetchMock.mockResolvedValue(
      streamingResponse([
        'data: {"type":"thinking_start","done":false}\n',
        'data: {"type":"text","text":"Hello","done":false}\n',
        'data: {"type":"text","text":" world","done":false}\n',
      ])
    );
    const { chunks, onChunk } = collectChunks();

    await respondTextStream(makeRequest(), onChunk);

    expect(chunks).toEqual([
      { type: 'thinking_start', done: false },
      { type: 'text', text: 'Hello', done: false },
      { type: 'text', text: ' world', done: false },
    ]);
  });

  it('buffers data events split across multiple reader reads', async () => {
    fetchMock.mockResolvedValue(
      streamingResponse(['data: {"type":"text","te', 'xt":"split","done":false}\n'])
    );
    const { chunks, onChunk } = collectChunks();

    await respondTextStream(makeRequest(), onChunk);

    expect(chunks).toEqual([{ type: 'text', text: 'split', done: false }]);
  });

  it('forwards error events through onChunk instead of throwing', async () => {
    fetchMock.mockResolvedValue(
      streamingResponse(['data: {"type":"error","error":"boom","done":false}\n'])
    );
    const { chunks, onChunk } = collectChunks();

    await expect(respondTextStream(makeRequest(), onChunk)).resolves.toBeUndefined();
    // `expect<unknown>` because bun-types types `toEqual` against the received
    // type, and the server is free to send an error chunk with `done: false`.
    expect<unknown>(chunks).toEqual([{ type: 'error', error: 'boom', done: false }]);
  });

  it('ignores malformed JSON and non-data lines without throwing', async () => {
    fetchMock.mockResolvedValue(
      streamingResponse([
        ': keep-alive comment\n',
        '\n',
        'data: not-json\n',
        'data: {"type":"text","text":"ok","done":false}\n',
      ])
    );
    const { chunks, onChunk } = collectChunks();

    await respondTextStream(makeRequest(), onChunk);

    expect(chunks).toEqual([{ type: 'text', text: 'ok', done: false }]);
  });

  it('throws the server-provided error message when the response is not ok', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Rate limited' }), { status: 429 })
    );
    const { onChunk } = collectChunks();

    await expect(respondTextStream(makeRequest(), onChunk)).rejects.toThrow('Rate limited');
  });

  it('throws the neutral fallback when an error response has no parseable body', async () => {
    fetchMock.mockResolvedValue(new Response('upstream exploded', { status: 500 }));
    const { onChunk } = collectChunks();

    await expect(respondTextStream(makeRequest(), onChunk)).rejects.toThrow(en.errors.unknown);
  });

  it('throws the neutral fallback when an ok response carries no body', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const { onChunk } = collectChunks();

    await expect(respondTextStream(makeRequest(), onChunk)).rejects.toThrow(en.errors.unknown);
  });
});

describe('startExternalReviewStream', () => {
  let fetchMock: ReturnType<typeof jest.fn>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    fetchMock = jest.fn();
    // `vi.stubGlobal` / `vi.unstubAllGlobals` do not exist on Bun; the original
    // is captured and put back by hand. `bun.setup.ts` also reinstates its
    // unreachable `fetch` after every test, so a missed restore cannot leak.
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('rejects after a terminal setup-error chunk so the review action can toast', async () => {
    fetchMock.mockResolvedValue(
      streamingResponse([
        'data: {"type":"error","error":"This agent does not offer a review of your working tree.","done":true}\n',
      ])
    );
    const { chunks, onChunk } = collectChunks();

    await expect(
      startExternalReviewStream('chat-1', { target: { type: 'uncommittedChanges' } }, onChunk)
    ).rejects.toThrow('This agent does not offer a review of your working tree.');
    expect(chunks).toEqual([
      {
        type: 'error',
        error: 'This agent does not offer a review of your working tree.',
        done: true,
      },
    ]);
  });
});

describe('generateImage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the generated image payload on success', async () => {
    const payload = {
      userMessage: { id: 'user-msg-1' },
      aiMessage: { id: 'ai-msg-1' },
    } as unknown as GenerateImageResponse;
    mockGeneratePost.mockResolvedValue({ data: payload, error: null });

    const request = makeImageRequest();
    const result = await generateImage(request);

    expect(mockGeneratePost).toHaveBeenCalledWith(request);
    expect(result).toBe(payload);
  });

  it('throws the API error message when generation fails', async () => {
    mockGeneratePost.mockResolvedValue({ data: null, error: { value: { error: 'No credits' } } });

    await expect(generateImage(makeImageRequest())).rejects.toThrow('No credits');
  });

  it('throws the neutral fallback when the error has no message', async () => {
    mockGeneratePost.mockResolvedValue({ data: null, error: { value: null } });

    await expect(generateImage(makeImageRequest())).rejects.toThrow(en.errors.unknown);
  });
});

describe('uploadReferenceImage', () => {
  // The error and reject paths log via console.error; silence it so the
  // expected-failure tests don't pollute the test output.
  let consoleErrorSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {
      /* swallow expected error logs in test */
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  const file = new File(['bytes'], 'ref.png', { type: 'image/png' });

  it('returns the uploaded image URL on success', async () => {
    mockUploadPost.mockResolvedValue({ data: { imageUrl: '/uploads/ref.png' }, error: null });

    await expect(uploadReferenceImage(file)).resolves.toBe('/uploads/ref.png');
    expect(mockUploadPost).toHaveBeenCalledWith({ image: file });
  });

  it('returns null when the API reports an error', async () => {
    mockUploadPost.mockResolvedValue({ data: null, error: { value: 'too large' } });

    await expect(uploadReferenceImage(file)).resolves.toBeNull();
  });

  it('returns null when the upload throws', async () => {
    mockUploadPost.mockRejectedValue(new Error('network down'));

    await expect(uploadReferenceImage(file)).resolves.toBeNull();
  });

  it('returns null when the response omits an image URL', async () => {
    mockUploadPost.mockResolvedValue({ data: {}, error: null });

    await expect(uploadReferenceImage(file)).resolves.toBeNull();
  });
});
