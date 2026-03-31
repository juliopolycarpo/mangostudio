import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test';

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
  for (const chunk of MOCK_CHUNKS) {
    yield chunk;
  }
}

describe('GeminiProvider.generateTextStream', () => {
  let originalModule: any;

  beforeEach(() => {
    // Stash the real module reference so we can restore after tests
    originalModule = null;
  });

  afterEach(() => {
    // Clear module cache between tests (Bun test isolation)
    mock.restore();
  });

  it('yields text chunks and a final done:true sentinel', async () => {
    mock.module('@google/genai', () => ({
      GoogleGenAI: class {
        models = {
          generateContentStream: async () => mockStream(),
        };
      },
    }));

    // Also mock the secret resolution so we don't need real API keys
    mock.module('../../../../src/services/gemini/secret', () => ({
      getResolvedGeminiApiKey: async () => 'mock-api-key',
    }));

    const { generateTextStream } = await import('../../../../src/services/gemini/text');

    const chunks: Array<{ type?: string; text?: string; done: boolean }> = [];
    for await (const chunk of generateTextStream('user-1', [], 'Hi', undefined, 'gemini-2.0-flash')) {
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
    mock.module('@google/genai', () => ({
      GoogleGenAI: class {
        models = {
          generateContentStream: async () =>
            (async function* () {
              yield { text: '', promptFeedback: { blockReason: 'SAFETY' }, candidates: undefined };
            })(),
        };
      },
    }));

    mock.module('../../../../src/services/gemini/secret', () => ({
      getResolvedGeminiApiKey: async () => 'mock-api-key',
    }));

    const { generateTextStream } = await import('../../../../src/services/gemini/text');

    await expect(async () => {
      for await (const _ of generateTextStream('user-1', [], 'bad prompt', undefined, 'gemini-2.0-flash')) {
        // consume
      }
    }).toThrow('Prompt blocked: SAFETY');
  });

  it('throws when no modelName is provided', async () => {
    const { generateTextStream } = await import('../../../../src/services/gemini/text');

    await expect(async () => {
      for await (const _ of generateTextStream('user-1', [], 'Hi', undefined, undefined)) {
        // consume
      }
    }).toThrow('No Gemini text model was provided.');
  });
});

describe('GeminiProvider generateTextStream delegation', () => {
  it('generateTextStream is defined on the provider', async () => {
    const { geminiProvider } = await import('../../../../src/services/providers/gemini-provider');
    expect(typeof geminiProvider.generateTextStream).toBe('function');
  });

  it('generateTextStream returns an AsyncIterable', async () => {
    mock.module('@google/genai', () => ({
      GoogleGenAI: class {
        models = {
          generateContentStream: async () => mockStream(),
        };
      },
    }));

    mock.module('../../../../src/services/gemini/secret', () => ({
      getResolvedGeminiApiKey: async () => 'mock-api-key',
    }));

    const { geminiProvider } = await import('../../../../src/services/providers/gemini-provider');

    const iterable = geminiProvider.generateTextStream!({
      userId: 'user-1',
      history: [],
      prompt: 'Hi',
      modelName: 'gemini-2.0-flash',
    });

    expect(iterable).toBeDefined();
    expect(typeof (iterable as any)[Symbol.asyncIterator]).toBe('function');
  });
});
