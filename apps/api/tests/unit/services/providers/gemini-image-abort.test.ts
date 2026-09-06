import { describe, expect, it } from 'bun:test';
import type { createGeminiClient } from '../../../../src/services/providers/gemini/client';
import { generateGeminiImage } from '../../../../src/services/providers/gemini/image-generation';

const USER_ID = 'user-gemini-image-abort';
const MODEL_ID = 'gemini-2.5-flash-image';

/**
 * Stands in for an SDK that only honours an abort landing *after* dispatch: it
 * forwards `config.abortSignal` but never reads `signal.aborted`, so a signal
 * that fired before the call is ignored and the request runs to completion.
 * That was `@google/genai` 1.52 exactly; 2.x checks `aborted` up front. The
 * fake keeps the old behaviour on purpose — one that rejected on an
 * already-aborted signal would pass with or without the guard under test.
 */
class SignalIgnoringGeminiClient {
  callCount = 0;
  observedAbortSignal: AbortSignal | undefined;

  readonly models = {
    generateContent: (request: { config?: Record<string, unknown> }) => {
      this.callCount += 1;
      this.observedAbortSignal = request.config?.abortSignal as AbortSignal | undefined;
      return Promise.resolve({
        candidates: [
          {
            finishReason: 'STOP',
            content: { parts: [{ inlineData: { data: 'aGk=', mimeType: 'image/png' } }] },
          },
        ],
      });
    },
  };

  /** The SDK surface `generateGeminiImage` uses, without the rest of the client. */
  asClient(): ReturnType<typeof createGeminiClient> {
    return this as unknown as ReturnType<typeof createGeminiClient>;
  }
}

describe('generateGeminiImage — abort signal', () => {
  it('refuses to dispatch a request whose signal aborted before the call', async () => {
    const client = new SignalIgnoringGeminiClient();
    const controller = new AbortController();
    controller.abort();

    // A Stop that lands while key resolution or the reference-image read is
    // still awaiting leaves an aborted signal at the dispatch point. The SDK
    // drops it, so the guard has to be the one that refuses.
    await expect(
      generateGeminiImage(
        USER_ID,
        'Paint mangoes',
        undefined,
        undefined,
        '1K',
        MODEL_ID,
        client.asClient(),
        controller.signal
      )
    ).rejects.toThrow('Image generation was aborted.');

    expect(client.callCount).toBe(0);
  });

  it('hands a live signal to the SDK instead of refusing the call', async () => {
    const client = new SignalIgnoringGeminiClient();
    const controller = new AbortController();

    const imageUrl = await generateGeminiImage(
      USER_ID,
      'Paint mangoes',
      undefined,
      undefined,
      '1K',
      MODEL_ID,
      client.asClient(),
      controller.signal
    );

    expect(imageUrl).toStartWith('/images/');
    expect(client.callCount).toBe(1);
    expect(client.observedAbortSignal).toBe(controller.signal);
  });
});
