import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { AgentEvent } from '@mangostudio/shared';
import { getDb } from '../../../../src/db/database';
import {
  IMAGE_ABANDONED_ERROR,
  IMAGE_ABANDONED_ERROR_CODE,
} from '../../../../src/modules/generation/application/image-interruption';
import type { SubagentTurnSession } from '../../../../src/modules/generation/application/subagent-turn-stages';
import {
  getProvider,
  registerProvider,
} from '../../../../src/services/providers/core/provider-registry';
import type {
  AIProvider,
  ImageGenerationRequest,
  ImageGenerationResult,
} from '../../../../src/services/providers/types';
import { GENERATE_IMAGE_TOOL_NAME } from '../../../../src/services/tools/builtin/generate-image';
import { ensureTestUsers, insertTestConnector } from '../../../support/factories';

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
  private readonly pendingRejects: Array<(error: Error) => void> = [];

  generateText: AIProvider['generateText'] = () => Promise.resolve({ text: '' });
  listModels: AIProvider['listModels'] = () => Promise.resolve([]);
  validateApiKey: AIProvider['validateApiKey'] = () => Promise.resolve();
  resolveApiKey: AIProvider['resolveApiKey'] = () => Promise.resolve('fake-api-key');

  generateImage = (request: ImageGenerationRequest): Promise<ImageGenerationResult> => {
    this.callCount += 1;
    this.observedSignal = request.signal;
    // An already-aborted signal rejects up front, the way `fetch` and the
    // provider SDKs do. Waiting on the `abort` event alone would never settle
    // for a signal that fired before this call, and the generator awaiting it
    // would hang to the test timeout instead of failing on the assertion.
    if (request.signal?.aborted) {
      return Promise.reject(new DOMException('The image request was aborted.', 'AbortError'));
    }
    return new Promise((_resolve, reject) => {
      this.pendingRejects.push(reject);
      request.signal?.addEventListener('abort', () => {
        reject(new DOMException('The image request was aborted.', 'AbortError'));
      });
    });
  };

  /**
   * Settles every call still in flight. A test whose subject is the signal it
   * *observed* has nothing left to abort, and without this the unsettled
   * promise would hold the caller open until the test timeout instead of the
   * assertion deciding the outcome.
   */
  releasePending(): void {
    for (const reject of this.pendingRejects.splice(0)) {
      reject(new Error('Provider call released by the test.'));
    }
  }
}

/**
 * Blocks until `predicate` holds, so a test can meet the generator where it
 * actually is instead of guessing how many macrotasks `resolveModel`, the
 * connector lookup and `warmProviderForRequest` need to reach the provider.
 *
 * // Usage: await waitFor(() => fake.callCount >= 1, 'the first provider call');
 */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

let previousProvider: AIProvider | null = null;

beforeAll(async () => {
  await ensureTestUsers({
    id: USER_ID,
    name: 'Abort Signal Test User',
    email: `${USER_ID}@mangostudio.test`,
  });
  // Routes `resolveModel`/`getProviderForModel` to the fake provider through
  // the real connector-lookup path, instead of mocking a shared module —
  // `resolve-model.ts` is imported by other test files, and Bun's
  // `mock.module` replaces it process-wide for the rest of the run.
  await insertTestConnector(USER_ID, {
    id: `generate-image-abort-signal-${MODEL_ID}`,
    name: 'Abort Signal Test Connector',
    enabledModels: [MODEL_ID],
  });
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

    await waitFor(() => fake.callCount >= 1, 'the provider call to start');

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

    // Abort mid-flight, while the fake provider's promise is still pending —
    // which is only true once the call has actually started.
    await waitFor(() => fake.callCount >= 1, 'the first provider call to start');
    controller.abort();
    await drain;

    // Only the in-flight image was attempted — the between-images check still
    // stops the loop before the second, unreached image is ever started.
    expect(fake.callCount).toBe(1);
    // The image that was in flight and the one never reached are the same
    // gesture to the user, so they must carry the same reason. Without the
    // signal check this is whatever the SDK threw ('The image request was
    // aborted.' here, 'Request was aborted.' from OpenAI) with no `errorCode`,
    // which `GeneratedImagePart` then renders verbatim and untranslated.
    expect(outcomes).toEqual([
      expect.objectContaining({
        type: 'failed',
        error: IMAGE_ABANDONED_ERROR,
        errorCode: IMAGE_ABANDONED_ERROR_CODE,
      }),
    ]);
  }, 5000);
});

/**
 * Drives one subagent tool loop: announces a single `generate_image` call, then
 * completes the turn. Enough of a provider for `runSubagentStreamLoop`, which
 * only reads the agent-event stream.
 */
class SingleImageCallAgentProvider {
  readonly providerType = 'openai-compatible' as const;

  // biome-ignore lint/suspicious/useAwait: an async generator is the stream contract.
  generateAgentTurnStream = async function* (): AsyncIterable<AgentEvent> {
    yield {
      type: 'tool_call_completed',
      callId: 'subagent-call-1',
      name: GENERATE_IMAGE_TOOL_NAME,
      arguments: JSON.stringify({ prompt: 'Paint mangoes', model: MODEL_ID }),
    };
    yield { type: 'turn_completed' };
  };
}

/** Minimal session for `runSubagentStreamLoop`, carrying the delegating signal. */
function createSubagentSession(signal: AbortSignal): SubagentTurnSession {
  return {
    input: {
      userId: USER_ID,
      chatId: 'chat-generate-image-abort-signal',
      db: getDb(),
      signal,
      request: {},
      settings: { defaultMaxTurns: 1 },
    },
    resolvedModel: {
      modelId: MODEL_ID,
      capabilities: { text: true, image: true, streaming: true },
    },
    provider: new SingleImageCallAgentProvider(),
    runtime: {
      profile: { id: 'default' },
      runtimeHash: 'subagent-abort-signal-hash',
      effectiveSystemPrompt: undefined,
      runtimeSettings: {},
      toolSettingsByName: new Map(),
    },
    toolDefinitions: [],
    allowedToolNames: new Set([GENERATE_IMAGE_TOOL_NAME]),
    prompt: 'Paint mangoes.',
    transcript: [],
    tools: [],
    summary: '',
  } as unknown as SubagentTurnSession;
}

describe('executeSubagentTools — abort signal threading', () => {
  it('forwards the delegating turn signal into a builtin the subagent runs', async () => {
    const fake = withFakeProvider();
    const { runSubagentStreamLoop } = await import(
      '../../../../src/modules/generation/application/subagent-turn-stages'
    );

    const controller = new AbortController();
    const loop = runSubagentStreamLoop(createSubagentSession(controller.signal));

    await waitFor(() => fake.callCount >= 1, 'the subagent provider call to start');
    const observed = fake.observedSignal;
    fake.releasePending();
    await loop;

    // A subagent's `generate_image` reaches the provider through the same
    // request as the parent's, so a Stop has to reach it the same way. Without
    // the forward this is `undefined` and the request outlives the turn.
    expect(observed).toBeInstanceOf(AbortSignal);
    expect(observed).toBe(controller.signal);
  }, 5000);
});
