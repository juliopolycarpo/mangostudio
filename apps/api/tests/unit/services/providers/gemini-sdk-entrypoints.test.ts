import { describe, expect, it } from 'bun:test';

import { GoogleGenAI as NodeGoogleGenAI } from '@google/genai/node';
import { GoogleGenAI } from '@google/genai/web';

import { FakeGeminiHttp } from '../../../support/providers/fake-gemini-http';

type Entry = 'node' | 'web';
const ENTRIES: Entry[] = ['node', 'web'];

function client(entry: Entry, peer: FakeGeminiHttp) {
  const Constructor = entry === 'web' ? GoogleGenAI : NodeGoogleGenAI;
  return new Constructor({
    apiKey: 'synthetic-key',
    httpOptions: {
      baseUrl: 'https://gemini.invalid',
      fetch: peer.fetch,
      retryOptions: { attempts: 1 },
    },
  });
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/** Runs each public entry with its own peer and compares normalized results and requests. */
async function expectParity(
  run: (sdk: ReturnType<typeof client>, peer: FakeGeminiHttp) => Promise<unknown>,
  behavior: ConstructorParameters<typeof FakeGeminiHttp>[0] = 'normal'
): Promise<void> {
  const observations = [];
  for (const entry of ENTRIES) {
    const peer = new FakeGeminiHttp(behavior);
    const value = await run(client(entry, peer), peer);
    observations.push({ value: plain(value), requests: peer.requests });
  }
  expect(observations[1]).toEqual(observations[0]);
}

describe('Google SDK public entrypoint parity', () => {
  it('rejects unexpected endpoints and methods rather than returning a generated response', async () => {
    const peer = new FakeGeminiHttp();
    await expect(
      peer.fetch('https://gemini.invalid/v1beta/typo', { method: 'POST' })
    ).rejects.toThrow('received: POST /v1beta/typo');
    await expect(
      peer.fetch('https://gemini.invalid/v1beta/models/gemini-test:generateContent')
    ).rejects.toThrow('received: GET /v1beta/models/gemini-test:generateContent');
    expect(peer.requests).toHaveLength(0);
  });

  it('lists models and sends the explicit API key', async () => {
    await expectParity(async (sdk, peer) => {
      const models = [];
      for await (const model of await sdk.models.list()) models.push(model.name);
      expect(models).toEqual(['models/gemini-test']);
      expect(peer.requests).toHaveLength(1);
      expect(peer.requests[0]?.apiKey).toBe('synthetic-key');
      expect(peer.requests[0]).toMatchObject({
        url: 'https://gemini.invalid/v1beta/models',
        method: 'GET',
      });
      return models;
    });
  });

  it('preserves text, structured output and inline PNG/PDF inputs', async () => {
    await expectParity(async (sdk, peer) => {
      const response = await sdk.models.generateContent({
        model: 'gemini-test',
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'Test prompt' },
              { inlineData: { data: 'AA==', mimeType: 'image/png' } },
              { inlineData: { data: 'AA==', mimeType: 'application/pdf' } },
            ],
          },
        ],
        config: {
          systemInstruction: 'Be concise',
          responseMimeType: 'application/json',
          responseSchema: { type: 'OBJECT', properties: { answer: { type: 'STRING' } } },
        },
      });
      expect(response.text).toBe('Synthetic response');
      expect(peer.requests[0]).toMatchObject({
        url: 'https://gemini.invalid/v1beta/models/gemini-test:generateContent',
        method: 'POST',
      });
      expect(peer.requests[0]?.body).toMatchObject({
        systemInstruction: { role: 'user', parts: [{ text: 'Be concise' }] },
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: { type: 'OBJECT', properties: { answer: { type: 'STRING' } } },
        },
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'Test prompt' },
              { inlineData: { data: 'AA==', mimeType: 'image/png' } },
              { inlineData: { data: 'AA==', mimeType: 'application/pdf' } },
            ],
          },
        ],
      });
      return {
        text: response.text,
        candidates: response.candidates,
        usage: response.usageMetadata,
      };
    });
  });

  it('decodes generated inline images', async () => {
    await expectParity(async (sdk, peer) => {
      const response = await sdk.models.generateContent({
        model: 'gemini-test-image',
        contents: 'Draw mangoes',
        config: { responseModalities: ['IMAGE'] },
      });
      expect(response.candidates?.[0]?.content?.parts?.[0]?.inlineData).toEqual({
        data: 'aGk=',
        mimeType: 'image/png',
      });
      expect(peer.requests[0]).toMatchObject({
        url: 'https://gemini.invalid/v1beta/models/gemini-test-image:generateContent',
        method: 'POST',
        body: { generationConfig: { responseModalities: ['IMAGE'] } },
      });
      return response;
    }, 'image');
  });

  it('decodes generated-content SSE', async () => {
    await expectParity(async (sdk, peer) => {
      const stream = await sdk.models.generateContentStream({
        model: 'gemini-test',
        contents: 'Prompt',
      });
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk.text);
      expect(chunks).toEqual(['Synthetic response']);
      expect(peer.requests[0]).toMatchObject({
        url: 'https://gemini.invalid/v1beta/models/gemini-test:streamGenerateContent?alt=sse',
        method: 'POST',
      });
      return chunks;
    });
  });

  it('decodes Interactions SSE and forwards a live signal', async () => {
    await expectParity(async (sdk, peer) => {
      const controller = new AbortController();
      const stream = await sdk.interactions.create(
        { model: 'gemini-test', input: 'Prompt', stream: true },
        {
          signal: controller.signal,
        }
      );
      const events = [];
      for await (const event of stream) events.push(event);
      expect(events.map((event) => event.event_type)).toEqual([
        'interaction.created',
        'interaction.completed',
      ]);
      expect(peer.signal?.aborted).toBe(false);
      expect(peer.requests[0]).toMatchObject({
        url: 'https://gemini.invalid/v1beta/interactions',
        method: 'POST',
      });
      return events;
    });
  });

  it('rejects a pre-aborted image request before peer dispatch', async () => {
    await expectParity(async (sdk, peer) => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        sdk.models.generateContent({
          model: 'gemini-test-image',
          contents: 'Draw mangoes',
          config: { abortSignal: controller.signal, responseModalities: ['IMAGE'] },
        })
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(peer.requests).toHaveLength(0);
      return { dispatched: peer.requests.length, fetchInvocations: peer.invocations };
    });
  });

  it('cancels an in-flight request with the same failure category', async () => {
    await expectParity(async (sdk, peer) => {
      const controller = new AbortController();
      const pending = sdk.models.generateContent({
        model: 'gemini-test',
        contents: 'Prompt',
        config: { abortSignal: controller.signal },
      });
      const outcome = pending.then(
        () => null,
        (error: unknown) => error
      );
      await peer.started.promise;
      controller.abort();
      const error = await outcome;
      expect(error).toMatchObject({ name: 'AbortError' });
      expect(peer.signal?.aborted).toBe(true);
      return { name: (error as Error).name, message: (error as Error).message };
    }, 'stall');
  });

  it('preserves API status and provider messages', async () => {
    await expectParity(async (sdk) => {
      const outcome = await sdk.models
        .generateContent({ model: 'invalid', contents: 'Prompt' })
        .then(
          () => null,
          (error: unknown) => error
        );
      expect(outcome).toMatchObject({ status: 400 });
      expect((outcome as Error).message).toContain('invalid synthetic model');
      const error = outcome as Error & { status: number };
      return { name: error.name, status: error.status, message: error.message };
    }, 'error');
  });
});
