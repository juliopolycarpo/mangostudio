import { describe, expect, it } from 'bun:test';
import {
  buildGenerateImageToolDefinition,
  createGenerateImageToolPlan,
  summarizeGenerateImageToolResult,
  GENERATE_IMAGE_AUTO_MODEL,
  GENERATE_IMAGE_DEFAULT_QUALITY,
  type GenerateImageToolOutcome,
} from '../../../src/services/tools/builtin/generate-image';

describe('generate_image tool planning', () => {
  it('builds a one-image plan from defaults', () => {
    const plan = createGenerateImageToolPlan(
      { prompt: '  Draw a mango robot  ' },
      { toolCallId: 'tool-1', parameters: {}, imageIds: ['image-1'] }
    );

    expect(plan).toEqual({
      toolCallId: 'tool-1',
      prompt: 'Draw a mango robot',
      count: 1,
      quality: GENERATE_IMAGE_DEFAULT_QUALITY,
      requestedModel: undefined,
      imageIds: ['image-1'],
    });
  });

  it('uses settings and clamps requests to the configured maximum', () => {
    const plan = createGenerateImageToolPlan(
      { prompt: 'Paint mangoes', count: 8 },
      {
        toolCallId: 'tool-2',
        parameters: {
          defaultQuality: '2K',
          maxImagesPerCall: 2,
          defaultModel: 'gemini-image-model',
        },
        imageIds: ['image-a', 'image-b', 'image-c'],
      }
    );

    expect(plan).toMatchObject({
      count: 2,
      quality: '2K',
      requestedModel: 'gemini-image-model',
      imageIds: ['image-a', 'image-b'],
    });
  });

  it('lets call arguments override configured defaults', () => {
    const plan = createGenerateImageToolPlan(
      { prompt: 'Render a studio', count: 3, quality: '4K', model: 'custom-image-model' },
      {
        toolCallId: 'tool-3',
        parameters: {
          defaultQuality: '512px',
          maxImagesPerCall: 4,
          defaultModel: GENERATE_IMAGE_AUTO_MODEL,
        },
        imageIds: ['image-a', 'image-b', 'image-c'],
      }
    );

    expect(plan).toMatchObject({
      count: 3,
      quality: '4K',
      requestedModel: 'custom-image-model',
      imageIds: ['image-a', 'image-b', 'image-c'],
    });
  });

  it('rejects invalid image requests before provider execution', () => {
    expect(() => createGenerateImageToolPlan({}, { toolCallId: 'tool-4', parameters: {} })).toThrow(
      'Missing required prompt.'
    );

    expect(() =>
      createGenerateImageToolPlan(
        { prompt: 'Paint', count: 0 },
        { toolCallId: 'tool-4', parameters: {} }
      )
    ).toThrow('Image count must be at least 1.');

    expect(() =>
      createGenerateImageToolPlan(
        { prompt: 'Paint', quality: '8K' },
        { toolCallId: 'tool-4', parameters: {} }
      )
    ).toThrow('Unsupported image quality: "8K".');
  });
});

describe('generate_image provider definition', () => {
  it('reflects the effective image count limit in the tool schema', () => {
    const definition = buildGenerateImageToolDefinition({
      enabled: true,
      parameters: { maxImagesPerCall: 2 },
    });
    const parameters = definition.parameters as {
      properties: { count: { maximum: number } };
    };

    expect(parameters.properties.count.maximum).toBe(2);
  });
});

describe('generate_image tool result summary', () => {
  it('returns concise image URLs and errors for model feedback', () => {
    const outcomes: GenerateImageToolOutcome[] = [
      {
        type: 'completed',
        imageId: 'image-1',
        prompt: 'Paint mangoes',
        imageUrl: '/images/mango-1.png',
        modelName: 'gemini-image-model',
        generationTime: '1.2s',
        createdAt: 10,
      },
      {
        type: 'failed',
        imageId: 'image-2',
        prompt: 'Paint mangoes',
        error: 'Provider failed',
        modelName: 'gemini-image-model',
        generationTime: '0.4s',
        createdAt: 20,
      },
    ];

    expect(summarizeGenerateImageToolResult(outcomes)).toEqual({
      images: [
        {
          imageId: 'image-1',
          imageUrl: '/images/mango-1.png',
          modelName: 'gemini-image-model',
          generationTime: '1.2s',
        },
      ],
      errors: [
        {
          imageId: 'image-2',
          error: 'Provider failed',
          modelName: 'gemini-image-model',
          generationTime: '0.4s',
        },
      ],
      count: 1,
    });
  });
});
