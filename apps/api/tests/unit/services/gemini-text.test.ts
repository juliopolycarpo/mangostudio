import { describe, expect, it, mock, afterEach } from 'bun:test';

afterEach(() => {
  mock.restore();
});

describe('generateTextStream', () => {
  it('emits thinking chunks when thinkingVisibility is summary', async () => {
    // Mock the secret resolver
    mock.module('../../../src/services/gemini/secret', () => ({
      getResolvedGeminiApiKey: async () => 'fake-key',
    }));

    // Mock the GoogleGenAI SDK
    const mockStream = (async function* () {
      yield {
        candidates: [
          {
            content: {
              parts: [
                { thought: true, text: 'Let me think about this...' },
                { text: 'Here is my answer.' },
              ],
            },
          },
        ],
      };
    })();

    mock.module('@google/genai', () => ({
      GoogleGenAI: class {
        models = {
          generateContentStream: async () => mockStream,
        };
      },
    }));

    // Re-import after mocking
    const { generateTextStream } = await import('../../../src/services/gemini/text');

    const chunks = [];
    for await (const chunk of generateTextStream(
      'test-user',
      [],
      'Hello',
      undefined,
      'gemini-2.0-flash-thinking-exp',
      { thinkingVisibility: 'summary' }
    )) {
      chunks.push(chunk);
    }

    // Should have: thinking chunk, text chunk, done chunk
    expect(chunks.length).toBe(3);
    expect(chunks[0]).toEqual({ type: 'thinking', text: 'Let me think about this...', done: false });
    expect(chunks[1]).toEqual({ type: 'text', text: 'Here is my answer.', done: false });
    expect(chunks[2]).toEqual({ type: 'text', text: '', done: true });
  });

  it('emits only text chunks when thinkingVisibility is off', async () => {
    mock.module('../../../src/services/gemini/secret', () => ({
      getResolvedGeminiApiKey: async () => 'fake-key',
    }));

    let capturedConfig: Record<string, unknown> | undefined;

    const mockStream = (async function* () {
      yield {
        candidates: [
          {
            content: {
              parts: [{ text: 'Just text.' }],
            },
          },
        ],
      };
    })();

    mock.module('@google/genai', () => ({
      GoogleGenAI: class {
        models = {
          generateContentStream: async (opts: { config?: Record<string, unknown> }) => {
            capturedConfig = opts.config;
            return mockStream;
          },
        };
      },
    }));

    const { generateTextStream } = await import('../../../src/services/gemini/text');

    const chunks = [];
    for await (const chunk of generateTextStream(
      'test-user',
      [],
      'Hello',
      undefined,
      'gemini-2.0-flash',
      { thinkingVisibility: 'off' }
    )) {
      chunks.push(chunk);
    }

    // thinkingConfig should NOT be in the config
    expect(capturedConfig).toBeDefined();
    expect(capturedConfig!.thinkingConfig).toBeUndefined();

    // Should have: text chunk, done chunk
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toEqual({ type: 'text', text: 'Just text.', done: false });
    expect(chunks[1]).toEqual({ type: 'text', text: '', done: true });
  });

  it('falls back to chunk.text when candidate has no parts', async () => {
    mock.module('../../../src/services/gemini/secret', () => ({
      getResolvedGeminiApiKey: async () => 'fake-key',
    }));

    const mockStream = (async function* () {
      yield {
        text: 'Fallback text',
        candidates: [{}],
      };
    })();

    mock.module('@google/genai', () => ({
      GoogleGenAI: class {
        models = {
          generateContentStream: async () => mockStream,
        };
      },
    }));

    const { generateTextStream } = await import('../../../src/services/gemini/text');

    const chunks = [];
    for await (const chunk of generateTextStream(
      'test-user',
      [],
      'Hello',
      undefined,
      'gemini-2.0-flash',
      { thinkingVisibility: 'summary' }
    )) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(2);
    expect(chunks[0]).toEqual({ type: 'text', text: 'Fallback text', done: false });
    expect(chunks[1]).toEqual({ type: 'text', text: '', done: true });
  });
});
