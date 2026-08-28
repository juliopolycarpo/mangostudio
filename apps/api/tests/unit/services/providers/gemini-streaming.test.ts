import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { restoreGoogleGenAI } from '../../../support/mocks/google-genai';

/**
 * Unit tests for GeminiProvider.generateTextStream.
 * Mocks @google/genai to verify chunk yielding without real API calls.
 */

// Chunks the mock stream will yield
const MOCK_CHUNKS = [
  { text: 'Hello', candidates: undefined, promptFeedback: undefined },
  { text: ' world', candidates: undefined, promptFeedback: undefined },
  { text: '!', candidates: [{ finishReason: 'STOP' }], promptFeedback: undefined },
];

async function* mockStream() {
  await Promise.resolve();
  for (const chunk of MOCK_CHUNKS) {
    yield chunk;
  }
}

function mockGeminiSecretModule() {
  return {
    GeminiApiKeyMissingError: class GeminiApiKeyMissingError extends Error {},
    getResolvedGeminiApiKey: () => Promise.resolve('mock-api-key'),
    syncGeminiConfigFileConnectors: () => Promise.resolve(),
    validateGeminiApiKey: () => Promise.resolve(),
  };
}

describe('GeminiProvider.generateTextStream', () => {
  beforeEach(() => {
    // Reset module mocks between tests
  });

  afterEach(async () => {
    const { resetGeminiClientCache } = await import(
      '../../../../src/services/providers/gemini/client'
    );
    resetGeminiClientCache();
    // Clear module cache between tests (Bun test isolation)
    mock.restore();
    // …which does not revert mock.module(). This file runs in the isolated unit
    // lane, so its `@google/genai` fake cannot reach another file today; the
    // explicit restore keeps that true if it ever runs unisolated, and keeps
    // one mechanism for undoing this mock across the suite.
    await restoreGoogleGenAI();
  });

  it('yields text chunks and a final done:true sentinel', async () => {
    await mock.module('@google/genai', () => ({
      GoogleGenAI: class {
        models = {
          generateContentStream: () => Promise.resolve(mockStream()),
        };
      },
    }));

    // Also mock the secret resolution so we don't need real API keys
    await mock.module('../../../../src/services/providers/gemini/secret', mockGeminiSecretModule);

    const { generateGeminiTextStream } = await import(
      '../../../../src/services/providers/gemini/text'
    );

    const chunks: Array<{ type?: string; text?: string; done: boolean }> = [];
    for await (const chunk of generateGeminiTextStream(
      'user-1',
      [],
      'Hi',
      undefined,
      'gemini-2.0-flash'
    )) {
      chunks.push(chunk);
    }

    // Should receive one chunk per non-empty text, plus final done sentinel
    const textChunks = chunks.filter((c) => !c.done);
    const doneChunk = chunks.find((c) => c.done);

    expect(textChunks.length).toBe(3);
    expect(textChunks.map((c) => c.text).join('')).toBe('Hello world!');
    expect(doneChunk).toEqual({ type: 'text', text: '', done: true });
  });

  it('throws when prompt is blocked', async () => {
    await mock.module('@google/genai', () => ({
      GoogleGenAI: class {
        models = {
          generateContentStream: () =>
            Promise.resolve(
              (async function* () {
                await Promise.resolve();
                yield {
                  text: '',
                  promptFeedback: { blockReason: 'SAFETY' },
                  candidates: undefined,
                };
              })()
            ),
        };
      },
    }));

    await mock.module('../../../../src/services/providers/gemini/secret', mockGeminiSecretModule);

    const { generateGeminiTextStream } = await import(
      '../../../../src/services/providers/gemini/text'
    );

    await (expect(async () => {
      for await (const _chunk of generateGeminiTextStream(
        'user-1',
        [],
        'bad prompt',
        undefined,
        'gemini-2.0-flash'
      )) {
        // consume
      }
    }).toThrow('Prompt blocked: SAFETY') as unknown as Promise<void>);
  });

  it('throws when no modelName is provided', async () => {
    const { generateGeminiTextStream } = await import(
      '../../../../src/services/providers/gemini/text'
    );

    await (expect(async () => {
      for await (const _chunk of generateGeminiTextStream(
        'user-1',
        [],
        'Hi',
        undefined,
        undefined
      )) {
        // consume
      }
    }).toThrow('No Gemini text model was provided.') as unknown as Promise<void>);
  });

  it('emits thinking chunks when thinkingEnabled is true', async () => {
    await mock.module('@google/genai', () => ({
      GoogleGenAI: class {
        models = {
          generateContentStream: () =>
            Promise.resolve(
              (async function* () {
                await Promise.resolve();
                yield {
                  candidates: [
                    {
                      content: {
                        parts: [
                          { thought: true, text: 'Let me think...' },
                          { text: 'Here is my answer.' },
                        ],
                      },
                    },
                  ],
                };
              })()
            ),
        };
      },
    }));

    await mock.module('../../../../src/services/providers/gemini/secret', mockGeminiSecretModule);

    const { generateGeminiTextStream } = await import(
      '../../../../src/services/providers/gemini/text'
    );

    const chunks = [];
    for await (const chunk of generateGeminiTextStream(
      'user-1',
      [],
      'Hi',
      undefined,
      'gemini-2.0-flash-thinking-exp',
      { thinkingEnabled: true, reasoningEffort: 'medium' }
    )) {
      chunks.push(chunk);
    }

    expect(chunks[0]).toEqual({ type: 'thinking', text: 'Let me think...', done: false });
    expect(chunks[1]).toEqual({ type: 'text', text: 'Here is my answer.', done: false });
    expect(chunks[2]).toEqual({ type: 'text', text: '', done: true });
  });

  it('does not add thinkingConfig when thinkingEnabled is false', async () => {
    let capturedConfig: Record<string, unknown> | undefined;

    await mock.module('@google/genai', () => ({
      GoogleGenAI: class {
        models = {
          generateContentStream: (opts: { config?: Record<string, unknown> }) => {
            capturedConfig = opts.config;
            return Promise.resolve(
              (async function* () {
                await Promise.resolve();
                yield { candidates: [{ content: { parts: [{ text: 'text' }] } }] };
              })()
            );
          },
        };
      },
    }));

    await mock.module('../../../../src/services/providers/gemini/secret', mockGeminiSecretModule);

    const { generateGeminiTextStream } = await import(
      '../../../../src/services/providers/gemini/text'
    );

    for await (const _chunk of generateGeminiTextStream(
      'user-1',
      [],
      'Hi',
      undefined,
      'gemini-2.0-flash',
      {
        thinkingEnabled: false,
        reasoningEffort: 'medium',
      }
    )) {
      // consume
    }

    // Gemini 2.0 is a legacy model — no thinking support, config stays absent
    expect(capturedConfig?.thinkingConfig).toBeUndefined();
  });

  it('falls back to chunk.text when candidate has no parts', async () => {
    await mock.module('@google/genai', () => ({
      GoogleGenAI: class {
        models = {
          generateContentStream: () =>
            Promise.resolve(
              (async function* () {
                await Promise.resolve();
                yield { text: 'Fallback text', candidates: [{}] };
              })()
            ),
        };
      },
    }));

    await mock.module('../../../../src/services/providers/gemini/secret', mockGeminiSecretModule);

    const { generateGeminiTextStream } = await import(
      '../../../../src/services/providers/gemini/text'
    );

    const chunks = [];
    for await (const chunk of generateGeminiTextStream(
      'user-1',
      [],
      'Hi',
      undefined,
      'gemini-2.0-flash',
      { thinkingEnabled: true, reasoningEffort: 'medium' }
    )) {
      chunks.push(chunk);
    }

    expect(chunks[0]).toEqual({ type: 'text', text: 'Fallback text', done: false });
    expect(chunks[1]).toEqual({ type: 'text', text: '', done: true });
  });
});

describe('GeminiProvider generateTextStream delegation', () => {
  it('generateTextStream is defined on the provider', async () => {
    const { geminiProvider } = await import('../../../../src/services/providers/gemini/index');
    expect(typeof geminiProvider.generateTextStream).toBe('function');
  });

  it('generateTextStream returns an AsyncIterable', async () => {
    await mock.module('@google/genai', () => ({
      GoogleGenAI: class {
        models = {
          generateContentStream: () => Promise.resolve(mockStream()),
        };
      },
    }));

    await mock.module('../../../../src/services/providers/gemini/secret', mockGeminiSecretModule);

    const { geminiProvider } = await import('../../../../src/services/providers/gemini/index');

    if (!geminiProvider.generateTextStream) {
      throw new Error('geminiProvider.generateTextStream must be implemented');
    }

    const iterable = geminiProvider.generateTextStream({
      userId: 'user-1',
      history: [],
      prompt: 'Hi',
      modelName: 'gemini-2.0-flash',
    });

    expect(iterable).toBeDefined();
    expect(typeof (iterable as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe('function');
  });
});
