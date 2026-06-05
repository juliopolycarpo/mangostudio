/**
 * Built-in tool: generate_image
 * Creates one or more generated images during an agentic text turn.
 */

import { resolveModel } from '../../../modules/generation/application/resolve-model';
import { generateId } from '../../../utils/id';
import { warmProviderForRequest } from '../../providers/core/provider-readiness';
import { getProvider, getProviderForModel } from '../../providers/core/provider-registry';
import type { ImageGenerationRequest, ImageGenerationResult } from '../../providers/types';
import { registerTool } from '../registry';
import type { EffectiveToolSettings, ToolContext, ToolDefinition } from '../types';

export const GENERATE_IMAGE_TOOL_NAME = 'generate_image';

export const GENERATE_IMAGE_DEFAULT_QUALITY = '1K';
export const GENERATE_IMAGE_DEFAULT_MAX_IMAGES = 4;
export const GENERATE_IMAGE_HARD_MAX_IMAGES = 8;
export const GENERATE_IMAGE_AUTO_MODEL = 'auto';

const QUALITY_OPTIONS = ['512px', '1K', '2K', '4K'] as const;

export interface GenerateImageToolPlan {
  toolCallId: string;
  prompt: string;
  count: number;
  quality: string;
  requestedModel?: string;
  imageIds: string[];
}

export interface CreateGenerateImageToolPlanInput {
  toolCallId: string;
  parameters: Record<string, unknown>;
  imageIds?: string[];
}

export interface GenerateImageToolCompletedOutcome {
  type: 'completed';
  imageId: string;
  prompt: string;
  imageUrl: string;
  modelName: string;
  generationTime: string;
  createdAt: number;
}

export interface GenerateImageToolFailedOutcome {
  type: 'failed';
  imageId: string;
  prompt: string;
  error: string;
  modelName?: string;
  generationTime?: string;
  createdAt: number;
}

export type GenerateImageToolOutcome =
  | GenerateImageToolCompletedOutcome
  | GenerateImageToolFailedOutcome;

export interface GenerateImageToolResult {
  images: Array<{
    imageId: string;
    imageUrl: string;
    modelName: string;
    generationTime: string;
  }>;
  errors?: Array<{
    imageId: string;
    error: string;
    modelName?: string;
    generationTime?: string;
  }>;
  count: number;
}

interface GenerateImageToolSettings {
  defaultQuality: string;
  maxImagesPerCall: number;
  defaultModel: string;
  letAiDecideQuality: boolean;
}

const definition = buildDefinitionFromMaxImages(GENERATE_IMAGE_DEFAULT_MAX_IMAGES);

export function buildGenerateImageToolDefinition(settings: EffectiveToolSettings): ToolDefinition {
  const toolSettings = normalizeGenerateImageToolSettings(settings.parameters);
  return buildDefinitionFromMaxImages(toolSettings.maxImagesPerCall);
}

export function createGenerateImageToolPlan(
  args: Record<string, unknown>,
  input: CreateGenerateImageToolPlanInput
): GenerateImageToolPlan {
  const settings = normalizeGenerateImageToolSettings(input.parameters);
  const prompt = getRequiredString(args.prompt, 'prompt');
  const count = getRequestedImageCount(args.count, settings.maxImagesPerCall);
  const quality = getImageQuality(
    settings.letAiDecideQuality ? args.quality : undefined,
    settings.defaultQuality
  );
  const model = getOptionalString(args.model) ?? settings.defaultModel;
  const imageIds = buildImageIds(count, input.imageIds);

  return {
    toolCallId: input.toolCallId,
    prompt,
    count,
    quality,
    requestedModel: model === GENERATE_IMAGE_AUTO_MODEL ? undefined : model,
    imageIds,
  };
}

export async function* generateImagesForToolPlan(
  plan: GenerateImageToolPlan,
  context: { userId: string; signal?: AbortSignal }
): AsyncGenerator<GenerateImageToolOutcome> {
  let modelName: string | undefined;
  let providerGenerateImage:
    | ((request: ImageGenerationRequest) => Promise<ImageGenerationResult>)
    | undefined;

  try {
    const resolvedModel = await resolveModel({
      requestedModel: plan.requestedModel,
      userId: context.userId,
      type: 'image',
    });
    modelName = resolvedModel.modelId;
    const provider = resolvedModel.providerType
      ? getProvider(resolvedModel.providerType)
      : await getProviderForModel(modelName, context.userId);
    if (!provider.generateImage) {
      throw new Error('The resolved provider does not support image generation.');
    }
    await warmProviderForRequest(provider.providerType, {
      userId: context.userId,
      modelName,
      purpose: 'image',
    });
    providerGenerateImage = (request) => {
      if (!provider.generateImage) {
        return Promise.reject(
          new Error('The resolved provider does not support image generation.')
        );
      }

      return provider.generateImage(request);
    };
  } catch (error) {
    yield* failEveryPlannedImage(plan, error, modelName);
    return;
  }

  for (const imageId of plan.imageIds) {
    if (context.signal?.aborted) return;

    const startedAt = Date.now();
    try {
      const { imageUrl } = await providerGenerateImage({
        userId: context.userId,
        prompt: plan.prompt,
        imageSize: plan.quality,
        modelName,
      });

      yield {
        type: 'completed',
        imageId,
        prompt: plan.prompt,
        imageUrl,
        modelName,
        generationTime: formatDurationSince(startedAt),
        createdAt: Date.now(),
      };
    } catch (error) {
      yield {
        type: 'failed',
        imageId,
        prompt: plan.prompt,
        error: errorToMessage(error),
        modelName,
        generationTime: formatDurationSince(startedAt),
        createdAt: Date.now(),
      };
    }
  }
}

export function summarizeGenerateImageToolResult(
  outcomes: GenerateImageToolOutcome[]
): GenerateImageToolResult {
  const images = outcomes
    .filter((outcome): outcome is GenerateImageToolCompletedOutcome => outcome.type === 'completed')
    .map((outcome) => ({
      imageId: outcome.imageId,
      imageUrl: outcome.imageUrl,
      modelName: outcome.modelName,
      generationTime: outcome.generationTime,
    }));
  const errors = outcomes
    .filter((outcome): outcome is GenerateImageToolFailedOutcome => outcome.type === 'failed')
    .map((outcome) => ({
      imageId: outcome.imageId,
      error: outcome.error,
      modelName: outcome.modelName,
      generationTime: outcome.generationTime,
    }));

  return {
    images,
    ...(errors.length > 0 ? { errors } : {}),
    count: images.length,
  };
}

async function execute(
  args: Record<string, unknown>,
  context: ToolContext
): Promise<GenerateImageToolResult> {
  const plan = createGenerateImageToolPlan(args, {
    toolCallId: generateId(),
    parameters: context.parameters,
  });
  const outcomes: GenerateImageToolOutcome[] = [];

  for await (const outcome of generateImagesForToolPlan(plan, { userId: context.userId })) {
    outcomes.push(outcome);
  }

  return summarizeGenerateImageToolResult(outcomes);
}

/** Registers this built-in tool. // Usage: register() */
export function register(): void {
  registerTool({
    definition,
    buildDefinition: buildGenerateImageToolDefinition,
    settings: {
      title: 'Image generation',
      description: 'Allows text models to generate images while answering in chat.',
      category: 'image',
      enabledByDefault: true,
      canDisable: true,
      defaultParameters: {
        defaultQuality: GENERATE_IMAGE_DEFAULT_QUALITY,
        maxImagesPerCall: GENERATE_IMAGE_DEFAULT_MAX_IMAGES,
        defaultModel: GENERATE_IMAGE_AUTO_MODEL,
        letAiDecideQuality: false,
      },
      parameterDescriptors: [
        {
          name: 'letAiDecideQuality',
          label: 'Let AI decide quality',
          description: 'When enabled, the AI can choose different image sizes per request.',
          type: 'boolean',
          required: true,
          defaultValue: false,
        },
        {
          name: 'defaultQuality',
          label: 'Default image quality',
          description: 'Quality used when the model does not request one.',
          type: 'select',
          required: true,
          defaultValue: GENERATE_IMAGE_DEFAULT_QUALITY,
          options: QUALITY_OPTIONS.map((quality) => ({ value: quality, label: quality })),
        },
        {
          name: 'maxImagesPerCall',
          label: 'Maximum images per call',
          description: 'Upper limit for a single tool call, even if the model asks for more.',
          type: 'number',
          required: true,
          defaultValue: GENERATE_IMAGE_DEFAULT_MAX_IMAGES,
          min: 1,
          max: GENERATE_IMAGE_HARD_MAX_IMAGES,
        },
        {
          name: 'defaultModel',
          label: 'Default image model',
          description: 'Use "auto" to select the first available image model.',
          type: 'string',
          required: true,
          defaultValue: GENERATE_IMAGE_AUTO_MODEL,
          modelType: 'image',
        },
      ],
    },
    execute,
  });
}

function buildDefinitionFromMaxImages(maxImagesPerCall: number): ToolDefinition {
  return {
    name: GENERATE_IMAGE_TOOL_NAME,
    description:
      'Generates images from a text prompt. Use this when the user asks to create, draw, render, visualize, or generate one or more images.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          minLength: 1,
          description: 'Detailed prompt describing the image to generate.',
        },
        count: {
          type: 'integer',
          minimum: 1,
          maximum: maxImagesPerCall,
          description: 'Number of images to generate in this call. Defaults to 1.',
        },
        quality: {
          type: 'string',
          enum: [...QUALITY_OPTIONS],
          description: `Optional quality preset. Defaults to ${GENERATE_IMAGE_DEFAULT_QUALITY}.`,
        },
        model: {
          type: 'string',
          description: 'Optional image-capable model ID. Omit to use the configured default.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  };
}

function normalizeGenerateImageToolSettings(
  parameters: Record<string, unknown>
): GenerateImageToolSettings {
  const defaultQuality = getImageQuality(undefined, parameters.defaultQuality);
  const maxImagesPerCall = getSettingsMaxImages(parameters.maxImagesPerCall);
  const defaultModel = getOptionalString(parameters.defaultModel) ?? GENERATE_IMAGE_AUTO_MODEL;
  const letAiDecideQuality = parameters.letAiDecideQuality === true;

  return { defaultQuality, maxImagesPerCall, defaultModel, letAiDecideQuality };
}

function getRequestedImageCount(value: unknown, maxImagesPerCall: number): number {
  if (value === undefined || value === null) return 1;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error('Image count must be an integer.');
  }
  if (value < 1) throw new Error('Image count must be at least 1.');
  return Math.min(value, maxImagesPerCall);
}

function getSettingsMaxImages(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return GENERATE_IMAGE_DEFAULT_MAX_IMAGES;
  }
  return Math.min(Math.max(value, 1), GENERATE_IMAGE_HARD_MAX_IMAGES);
}

function getImageQuality(value: unknown, fallback: unknown): string {
  const quality =
    getOptionalString(value) ?? getOptionalString(fallback) ?? GENERATE_IMAGE_DEFAULT_QUALITY;
  if (!isQualityOption(quality)) {
    throw new Error(`Unsupported image quality: "${quality}".`);
  }
  return quality;
}

function getRequiredString(value: unknown, name: string): string {
  const text = getOptionalString(value);
  if (!text) throw new Error(`Missing required ${name}.`);
  return text;
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function buildImageIds(count: number, providedIds: string[] | undefined): string[] {
  return Array.from({ length: count }, (_, index) => providedIds?.[index] ?? generateId());
}

function isQualityOption(value: string): value is (typeof QUALITY_OPTIONS)[number] {
  return QUALITY_OPTIONS.includes(value as (typeof QUALITY_OPTIONS)[number]);
}

function* failEveryPlannedImage(
  plan: GenerateImageToolPlan,
  error: unknown,
  modelName: string | undefined
): Generator<GenerateImageToolFailedOutcome> {
  const message = errorToMessage(error);
  for (const imageId of plan.imageIds) {
    yield {
      type: 'failed',
      imageId,
      prompt: plan.prompt,
      error: message,
      modelName,
      createdAt: Date.now(),
    };
  }
}

function formatDurationSince(startedAt: number): string {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Image generation failed';
}
