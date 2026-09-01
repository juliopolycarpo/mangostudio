import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { getDb } from '../../../../src/db/database';
import {
  getProvider,
  registerProvider,
} from '../../../../src/services/providers/core/provider-registry';
import type {
  AIProvider,
  ImageGenerationRequest,
  ImageGenerationResult,
} from '../../../../src/services/providers/types';

const USER_ID = 'user-generate-image-abort-signal';
const MODEL_ID = 'fake-abort-signal-image-model';

/**
 * Stands in for a real provider's HTTP/SDK call. Records whatever signal
 * `generateImagesForToolPlan` hands it and never resolves on its own — only
 * an abort settles it — so the test can tell a signal that was actually
 * wired to the request apart from one that was merely accepted and ignored.
 */
class AbortObservingImageProvider implements AIProvider {
  readonly providerType = 'openai-compatible' as const;
  observedSignal: AbortSignal | undefined;
  callCount = 0;

  generateText: AIProvider['generateText'] = () => Promise.resolve({ text: '' });
  listModels: AIProvider['listModels'] = () => Promise.resolve([]);
  validateApiKey: AIProvider['validateApiKey'] = () => Promise.resolve();
  resolveApiKey: AIProvider['resolveApiKey'] = () => Promise.resolve('fake-api-key');

  generateImage = (request: ImageGenerationRequest): Promise<ImageGenerationResult> => {
    this.callCount += 1;
    this.observedSignal = request.signal;
    return new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => {
        reject(new DOMException('The image request was aborted.', 'AbortError'));
      });
    });
  };
}

let previousProvider: AIProvider | null = null;

beforeAll(async () => {
  const db = getDb();
  await db
    .insertInto('user')
    .values({
      id: USER_ID,
      name: 'Abort Signal Test User',
      email: `${USER_ID}@mangostudio.test`,
      emailVerified: 0,
      image: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  // Routes `resolveModel`/`getProviderForModel` to the fake provider through
  // the real connector-lookup path, instead of mocking a shared module —
  // `resolve-model.ts` is imported by other test files, and Bun's
  // `mock.module` replaces it process-wide for the rest of the run.
  await db
    .insertInto('secret_metadata')
    .values({
      id: `generate-image-abort-signal-${MODEL_ID}`,
      name: 'Abort Signal Test Connector',
      provider: 'openai-compatible',
      configured: 1,
      source: 'config-file',
      maskedSuffix: 'test',
      updatedAt: Date.now(),
      lastValidatedAt: Date.now(),
      lastValidationError: null,
      enabledModels: JSON.stringify([MODEL_ID]),
      userId: USER_ID,
      baseUrl: null,
      organizationId: null,
      projectId: null,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
});

afterEach(() => {
  if (previousProvider) registerProvider(previousProvider);
  previousProvider = null;
});

/** Swaps in the fake provider for the connector's provider type. */
function withFakeProvider(): AbortObservingImageProvider {
  previousProvider = getProvider('openai-compatible');
  const fake = new AbortObservingImageProvider();
  registerProvider(fake);
  return fake;
}

describe('generateImagesForToolPlan — abort signal threading', () => {
  it('passes the turn signal into the provider request', async () => {
    const fake = withFakeProvider();
    const { createGenerateImageToolPlan, generateImagesForToolPlan } = await import(
      '../../../../src/services/tools/builtin/generate-image'
    );

    const plan = createGenerateImageToolPlan(
      { prompt: 'Paint mangoes', model: MODEL_ID },
      { toolCallId: 'call-1', parameters: {} }
    );
    const controller = new AbortController();

    // Drain one image's worth of outcomes without waiting for it to settle —
    // the fake never resolves on its own, only an abort does.
    const iterator = generateImagesForToolPlan(plan, {
      userId: USER_ID,
      signal: controller.signal,
    })[Symbol.asyncIterator]();
    const pending = iterator.next();

    // Give the generator a macrotask to reach the provider call before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fake.observedSignal).toBeInstanceOf(AbortSignal);
    expect(fake.observedSignal).toBe(controller.signal);

    controller.abort();
    await pending;
  }, 5000);

  it('lands an in-flight abort on the failed outcome path and leaves the rest for abandonUnreachedImages', async () => {
    const fake = withFakeProvider();
    const { createGenerateImageToolPlan, generateImagesForToolPlan } = await import(
      '../../../../src/services/tools/builtin/generate-image'
    );

    // Two images planned: the first is the one in flight when the abort
    // lands, the second is never attempted — that gap is what the caller's
    // `abandonUnreachedImages` fills in, not this generator.
    const plan = createGenerateImageToolPlan(
      { prompt: 'Paint mangoes', model: MODEL_ID, count: 2 },
      { toolCallId: 'call-1', parameters: {} }
    );
    const controller = new AbortController();

    const outcomes: Array<{ type: string }> = [];
    const drain = (async () => {
      for await (const outcome of generateImagesForToolPlan(plan, {
        userId: USER_ID,
        signal: controller.signal,
      })) {
        outcomes.push(outcome);
      }
    })();

    // Abort mid-flight, while the fake provider's promise is still pending.
    // resolveModel/getProvider/warmProviderForRequest all resolve first, so
    // give the generator a macrotask to reach the provider call.
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await drain;

    // Only the in-flight image was attempted — the between-images check still
    // stops the loop before the second, unreached image is ever started.
    expect(fake.callCount).toBe(1);
    expect(outcomes).toEqual([expect.objectContaining({ type: 'failed' })]);
  }, 5000);
});
