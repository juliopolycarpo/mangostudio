import { afterEach, beforeAll, describe, expect, it } from 'bun:test';

import type { MessagePart } from '@mangostudio/shared/types';

import { executeImageGenerationCall } from '../../../../src/modules/generation/application/stream-text-turn-helpers';
import {
  getProvider,
  registerProvider,
} from '../../../../src/services/providers/core/provider-registry';
import type {
  AIProvider,
  ImageGenerationRequest,
  ImageGenerationResult,
} from '../../../../src/services/providers/types';
import {
  createGenerateImageToolPlan,
  generateImagesForToolPlan,
  type GenerateImageToolOutcome,
} from '../../../../src/services/tools/builtin/generate-image';
import { startToolTimeout } from '../../../../src/services/tools/execution-timeout';
import { registerTools } from '../../../../src/services/tools/register-tools';
import { ensureTestUsers, insertTestConnector } from '../../../support/factories';

const USER_ID = 'user-generate-image-timeout';
const MODEL_ID = 'fake-timeout-image-model';
/** The shortest `timeoutSeconds` the setting accepts; see `TOOL_EXECUTION_TIMEOUT_SECONDS_MIN`. */
const SHORTEST_CONFIGURABLE_TIMEOUT_SECONDS = 5;

registerTools();

/**
 * Stands in for a provider whose image request never completes on its own.
 * It records each request's signal and rejects only when that signal aborts,
 * so a test can tell a request the deadline actually cancelled from one the
 * pipeline merely stopped waiting for.
 */
class HangingImageProvider implements AIProvider {
  readonly providerType = 'openai-compatible' as const;
  readonly observedSignals: AbortSignal[] = [];
  /** Requests whose own signal aborted while they were in flight. */
  abortedRequestCount = 0;

  generateText: AIProvider['generateText'] = () => Promise.resolve({ text: '' });
  listModels: AIProvider['listModels'] = () => Promise.resolve([]);
  validateApiKey: AIProvider['validateApiKey'] = () => Promise.resolve();
  resolveApiKey: AIProvider['resolveApiKey'] = () => Promise.resolve('fake-api-key');

  get callCount(): number {
    return this.observedSignals.length;
  }

  generateImage = (request: ImageGenerationRequest): Promise<ImageGenerationResult> => {
    const signal = request.signal;
    if (signal) this.observedSignals.push(signal);
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        this.abortedRequestCount += 1;
        reject(new DOMException('The image request was aborted.', 'AbortError'));
      });
    });
  };
}

/**
 * A provider client that never looks at the signal it is given: it neither
 * settles nor rejects. The pipeline must still end the call at the deadline.
 */
class SignalIgnoringImageProvider extends HangingImageProvider {
  override generateImage = (request: ImageGenerationRequest): Promise<ImageGenerationResult> => {
    if (request.signal) this.observedSignals.push(request.signal);
    return new Promise(() => {});
  };
}

const WAIT_FOR_DEADLINE_MS = 4_000;

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + WAIT_FOR_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out after ${WAIT_FOR_DEADLINE_MS}ms waiting for ${label}`);
}

let previousProvider: AIProvider | null = null;

beforeAll(async () => {
  await ensureTestUsers({
    id: USER_ID,
    name: 'Image Timeout Test User',
    email: `${USER_ID}@mangostudio.test`,
  });
  await insertTestConnector(USER_ID, {
    id: `generate-image-timeout-${MODEL_ID}`,
    name: 'Image Timeout Test Connector',
    enabledModels: [MODEL_ID],
  });
});

afterEach(() => {
  if (previousProvider) registerProvider(previousProvider);
  previousProvider = null;
});

function useFakeProvider<T extends HangingImageProvider>(fake: T): T {
  previousProvider = getProvider('openai-compatible');
  registerProvider(fake);
  return fake;
}

function toolCallExecution(parts: MessagePart[]) {
  const call = parts.find((part) => part.type === 'tool_call');
  return call?.type === 'tool_call' ? call.execution : undefined;
}

function startImageCall(options: { count: number; signal?: AbortSignal }) {
  const allParts: MessagePart[] = [];
  const call = (async () => {
    const events: Array<{ type: string; error?: string; errorCode?: string }> = [];
    for await (const event of executeImageGenerationCall(
      'image-timeout-call-1',
      'generate_image',
      JSON.stringify({ prompt: 'Paint mangoes', model: MODEL_ID, count: options.count }),
      {
        userId: USER_ID,
        signal: options.signal,
        allowedToolNames: new Set(['generate_image']),
        toolSettings: new Map([
          [
            'generate_image',
            {
              enabled: true,
              parameters: { timeoutSeconds: SHORTEST_CONFIGURABLE_TIMEOUT_SECONDS },
            },
          ],
        ]),
        allParts,
        generatedImageArtifacts: [],
        nextToolResults: [],
      }
    )) {
      events.push(event);
    }
    return events;
  })();
  return { allParts, call };
}

describe('executeImageGenerationCall — timeoutSeconds', () => {
  it('ends a call that outlives the configured limit as timed_out and aborts the provider request', async () => {
    const fake = useFakeProvider(new HangingImageProvider());
    const { allParts, call } = startImageCall({ count: 2 });

    const events = await call;

    expect(toolCallExecution(allParts)).toMatchObject({
      status: 'timed_out',
      reasonCode: 'timeout',
    });
    // The request was cancelled at the provider, not just abandoned: its own
    // signal fired, and only the first image was ever started.
    expect(fake.callCount).toBe(1);
    expect(fake.abortedRequestCount).toBe(1);
    expect(fake.observedSignals[0]?.aborted).toBe(true);
    // Nothing is left spinning: every planned image is settled, and the reason
    // names the timeout rather than a user interruption.
    expect(allParts.filter((part) => part.type === 'generated_image')).toEqual([
      expect.objectContaining({ status: 'error', error: expect.stringContaining('timed out') }),
      expect.objectContaining({ status: 'error', error: expect.stringContaining('timed out') }),
    ]);
    const failures = events.filter((event) => event.type === 'image_generation_failed');
    expect(failures).toHaveLength(2);
    for (const failure of failures) {
      expect(failure.errorCode).toBeUndefined();
    }
    expect(allParts.find((part) => part.type === 'tool_result')).toMatchObject({ isError: true });
  }, 20_000);

  it('still settles a user Stop that lands before the deadline as cancelled', async () => {
    const fake = useFakeProvider(new HangingImageProvider());
    const controller = new AbortController();
    const { allParts, call } = startImageCall({ count: 1, signal: controller.signal });

    await waitFor(() => fake.callCount >= 1, 'the provider call to start');
    controller.abort('client_disconnect');
    await call;

    expect(toolCallExecution(allParts)).toMatchObject({
      status: 'cancelled',
      reasonCode: 'user_cancelled',
    });
    expect(fake.observedSignals[0]?.aborted).toBe(true);
  }, 10_000);
});

describe('generateImagesForToolPlan — deadline signal', () => {
  async function drain(
    count: number,
    timeoutMs: number
  ): Promise<{ outcomes: GenerateImageToolOutcome[]; timedOut: boolean }> {
    const plan = createGenerateImageToolPlan(
      { prompt: 'Paint mangoes', model: MODEL_ID, count },
      { toolCallId: 'call-1', parameters: {} }
    );
    const guard = startToolTimeout(undefined, 'generate_image', timeoutMs);
    try {
      const outcomes: GenerateImageToolOutcome[] = [];
      for await (const outcome of generateImagesForToolPlan(plan, {
        userId: USER_ID,
        signal: guard.signal,
      })) {
        outcomes.push(outcome);
      }
      return { outcomes, timedOut: guard.timedOut };
    } finally {
      guard.dispose();
    }
  }

  it('fails the in-flight image and every unreached one with the timeout message', async () => {
    const fake = useFakeProvider(new HangingImageProvider());

    const { outcomes, timedOut } = await drain(3, 150);

    expect(timedOut).toBe(true);
    expect(fake.abortedRequestCount).toBe(1);
    expect(outcomes).toHaveLength(3);
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({
        type: 'failed',
        error: 'Tool "generate_image" timed out after 150ms',
      });
      expect(outcome).not.toHaveProperty('errorCode');
    }
  }, 10_000);

  it('ends the call at the deadline even when the provider ignores the signal', async () => {
    const fake = useFakeProvider(new SignalIgnoringImageProvider());

    const { outcomes } = await drain(1, 150);

    expect(fake.callCount).toBe(1);
    expect(fake.observedSignals[0]?.aborted).toBe(true);
    expect(outcomes).toEqual([
      expect.objectContaining({ type: 'failed', error: expect.stringContaining('timed out') }),
    ]);
  }, 10_000);
});
