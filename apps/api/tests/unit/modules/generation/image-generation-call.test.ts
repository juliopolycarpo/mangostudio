import { afterEach, describe, expect, it, mock } from 'bun:test';

import type { MessagePart } from '@mangostudio/shared/types';

import type { GenerateImageToolOutcome } from '../../../../src/services/tools/builtin/generate-image';
import * as realGenerateImage from '../../../../src/services/tools/builtin/generate-image';
import { registerTools } from '../../../../src/services/tools/register-tools';
import { moduleMockerFor } from '../../../support/mocks/module-mocks';

const mockModule = moduleMockerFor(import.meta.dir);

registerTools();

/**
 * Stands in for the provider loop inside `generateImagesForToolPlan`.
 *
 * The behaviour under test is that generator's documented abort path: it
 * `return`s at its per-image signal check instead of throwing, so it can end
 * having said nothing at all about the images it never reached.
 */
class TruncatingImageGenerator {
  /** Plans the provider was asked to generate, so a test can say nothing was started. */
  readonly plans: Array<{ prompt: string; imageIds: string[] }> = [];

  constructor(
    private readonly reachedCount: number,
    /** Called when the generator stops early, standing in for the turn being stopped mid-batch. */
    private readonly stopTurn: () => void
  ) {}

  generate = async function* (
    this: TruncatingImageGenerator,
    plan: { prompt: string; imageIds: string[] }
  ): AsyncGenerator<GenerateImageToolOutcome> {
    await Promise.resolve();
    this.plans.push(plan);
    for (const imageId of plan.imageIds.slice(0, this.reachedCount)) {
      yield {
        type: 'completed',
        imageId,
        prompt: plan.prompt,
        imageUrl: `/images/${imageId}.png`,
        modelName: 'test-image-model',
        generationTime: '1.0s',
        createdAt: Date.now(),
      };
    }
    if (this.reachedCount < plan.imageIds.length) this.stopTurn();
  };
}

async function runImageCall(options: {
  reachedCount: number;
  count: number;
  /** The turn is stopped while the batch is being generated. */
  aborted: boolean;
  /** What a durable checkpoint answers; the running marker is the first one. */
  durableCheckpointStored?: boolean;
  /** Runs when the durable running marker is requested, e.g. to stop the turn while it is written. */
  onDurableCheckpoint?: (controller: AbortController) => void;
  /** Stops the turn before the call starts. */
  abortedBeforeStart?: boolean;
}): Promise<{
  allParts: MessagePart[];
  events: Array<{ type: string }>;
  checkpoints: RecordedCheckpoint[];
  generator: TruncatingImageGenerator;
}> {
  const controller = new AbortController();
  const generator = new TruncatingImageGenerator(options.reachedCount, () => {
    if (options.aborted) controller.abort('client_disconnect');
  });
  await mockModule('../../../../src/services/tools/builtin/generate-image', () => ({
    ...realGenerateImage,
    generateImagesForToolPlan: generator.generate.bind(generator),
  }));

  // Imported after the mock so the helper binds to the stubbed generator.
  const { executeImageGenerationCall } =
    await import('../../../../src/modules/generation/application/stream-text-turn-helpers');

  if (options.abortedBeforeStart) controller.abort('client_disconnect');

  const allParts: MessagePart[] = [];
  const checkpoints: RecordedCheckpoint[] = [];
  const call = executeImageGenerationCall(
    'image-call-1',
    'generate_image',
    JSON.stringify({ prompt: 'Paint mangoes', count: options.count }),
    {
      userId: 'image-call-user',
      signal: controller.signal,
      allowedToolNames: new Set(['generate_image']),
      toolSettings: new Map(),
      allParts,
      generatedImageArtifacts: [],
      nextToolResults: [],
      checkpoint: (checkpointOptions) => {
        checkpoints.push({
          durable: checkpointOptions?.durable === true,
          execution: toolCallExecution(allParts)?.status,
          images: imageStatuses(allParts),
        });
        if (checkpointOptions?.durable) options.onDurableCheckpoint?.(controller);
        return Promise.resolve(
          checkpointOptions?.durable === true ? (options.durableCheckpointStored ?? true) : true
        );
      },
    }
  );
  const events: Array<{ type: string }> = [];
  for await (const event of call) {
    events.push(event);
  }

  return { allParts, events, checkpoints, generator };
}

/** The turn as it stood when the call asked for a checkpoint, and whether it asked for a durable one. */
interface RecordedCheckpoint {
  readonly durable: boolean;
  readonly execution: string | undefined;
  readonly images: string[];
}

function toolCallExecution(parts: MessagePart[]) {
  const call = parts.find((part) => part.type === 'tool_call');
  return call?.type === 'tool_call' ? call.execution : undefined;
}

function imageStatuses(parts: MessagePart[]): string[] {
  return parts.filter((part) => part.type === 'generated_image').map((part) => part.status);
}

afterEach(() => {
  mock.restore();
});

describe('executeImageGenerationCall — abandoned images', () => {
  it('settles a call the turn aborted as cancelled, not as a succeeded no-op', async () => {
    const { allParts } = await runImageCall({ reachedCount: 1, count: 3, aborted: true });

    expect(toolCallExecution(allParts)).toMatchObject({
      status: 'cancelled',
      reasonCode: 'user_cancelled',
    });
  });

  it('leaves no image part stranded at generating when the turn aborted', async () => {
    const { allParts } = await runImageCall({ reachedCount: 1, count: 3, aborted: true });

    expect(imageStatuses(allParts)).toEqual(['completed', 'error', 'error']);
  });

  it('reports the unreached images to the model instead of an empty success', async () => {
    const { allParts } = await runImageCall({ reachedCount: 0, count: 2, aborted: true });

    const result = allParts.find((part) => part.type === 'tool_result');
    expect(result).toMatchObject({ isError: true });
    const payload = JSON.parse(result?.type === 'tool_result' ? result.content : '{}') as {
      count: number;
      errors?: Array<{ error: string }>;
    };
    expect(payload.count).toBe(0);
    expect(payload.errors).toHaveLength(2);
  });

  it('files a partly generated call as failed so the resume prompt can retry it', async () => {
    const { allParts } = await runImageCall({ reachedCount: 1, count: 3, aborted: true });

    const result = allParts.find((part) => part.type === 'tool_result');
    expect(result).toMatchObject({ isError: true });
    const payload = JSON.parse(result?.type === 'tool_result' ? result.content : '{}') as {
      count: number;
      errors?: Array<{ error: string }>;
    };
    // The model still sees what landed; only the verdict on the call changes.
    expect(payload.count).toBe(1);
    expect(payload.errors).toHaveLength(2);
  });

  it('still settles a fully generated call as succeeded', async () => {
    const { allParts } = await runImageCall({ reachedCount: 2, count: 2, aborted: false });

    expect(toolCallExecution(allParts)).toMatchObject({ status: 'succeeded' });
    expect(imageStatuses(allParts)).toEqual(['completed', 'completed']);
  });

  it('streams a failure event for every unreached image so the open tab stops showing it as generating', async () => {
    const { events } = await runImageCall({ reachedCount: 1, count: 3, aborted: true });

    const failed = events.filter((event) => event.type === 'image_generation_failed');
    expect(failed).toHaveLength(2);
    // `errorCode` is what lets the open tab localize the card instead of
    // showing the model-facing English text verbatim.
    for (const event of failed) {
      expect(event).toMatchObject({ errorCode: 'image_generation_interrupted' });
    }
  });
});

describe('executeImageGenerationCall — durable checkpoints', () => {
  it('commits the running marker and each finished image durably, and nothing else', async () => {
    const { checkpoints } = await runImageCall({ reachedCount: 2, count: 2, aborted: false });

    const durable = checkpoints.filter((checkpoint) => checkpoint.durable);
    expect(durable).toEqual([
      // Awaited before the provider call: the record that a paid generation may be under way.
      { durable: true, execution: 'running', images: [] },
      // Each completed image is the paid result a lost record would make the model buy again.
      { durable: true, execution: 'running', images: ['completed', 'generating'] },
      { durable: true, execution: 'running', images: ['completed', 'completed'] },
    ]);
    // The queued announcement, the per-image start and the final settle stay ordinary writes.
    expect(checkpoints.length - durable.length).toBeGreaterThanOrEqual(3);
  });

  it('does not make a failed image durable, since nothing was paid for or produced', async () => {
    const { checkpoints } = await runImageCall({ reachedCount: 0, count: 1, aborted: true });

    expect(checkpoints.filter((checkpoint) => checkpoint.durable)).toEqual([
      { durable: true, execution: 'running', images: [] },
    ]);
  });
});

describe('executeImageGenerationCall — running marker gates the generation', () => {
  it('does not generate when the running marker could not be stored', async () => {
    const { allParts, generator, events } = await runImageCall({
      reachedCount: 2,
      count: 2,
      aborted: false,
      durableCheckpointStored: false,
    });

    expect(generator.plans).toEqual([]);
    expect(allParts.filter((part) => part.type === 'generated_image')).toEqual([]);
    expect(events.some((event) => event.type === 'image_generation_started')).toBe(false);
    expect(toolCallExecution(allParts)).toMatchObject({
      status: 'failed',
      reasonCode: 'execution_error',
    });
    const result = allParts.find((part) => part.type === 'tool_result');
    expect(result).toMatchObject({ isError: true });
    expect(result?.type === 'tool_result' ? result.content : '').toContain(
      'Tool \\"generate_image\\" was not started'
    );
  });

  it('does not generate when the turn is stopped while the marker is being written', async () => {
    const { allParts, generator } = await runImageCall({
      reachedCount: 2,
      count: 2,
      aborted: false,
      onDurableCheckpoint: (controller) => controller.abort('client_disconnect'),
    });

    expect(generator.plans).toEqual([]);
    expect(toolCallExecution(allParts)).toMatchObject({
      status: 'cancelled',
      reasonCode: 'user_cancelled',
    });
  });

  it('does not write a marker for a turn stopped before the call began', async () => {
    const { checkpoints, generator } = await runImageCall({
      reachedCount: 2,
      count: 2,
      aborted: false,
      abortedBeforeStart: true,
    });

    expect(generator.plans).toEqual([]);
    expect(checkpoints.filter((checkpoint) => checkpoint.durable)).toEqual([]);
  });
});
