import { describe, expect, it } from 'bun:test';
import { includeKnownOpenAIImageModels } from '../../../../src/services/providers/openai/model-catalog';
import type { ModelInfo } from '../../../../src/services/providers/types';

function makeTextModel(modelId: string): ModelInfo {
  return {
    modelId,
    displayName: modelId,
    provider: 'openai',
    capabilities: {
      text: true,
      image: false,
      streaming: true,
      reasoning: false,
      tools: true,
      statefulContinuation: true,
      promptCaching: true,
      parallelToolCalls: true,
      reasoningWithTools: false,
      structuredOutput: true,
    },
  };
}

describe('includeKnownOpenAIImageModels', () => {
  it('adds documented OpenAI image models when /models omits them', () => {
    const models = includeKnownOpenAIImageModels([makeTextModel('gpt-4o')]);
    const modelIds = models.map((model) => model.modelId);

    expect(modelIds).toContain('gpt-image-2');
    expect(modelIds).toContain('gpt-image-1.5');
    expect(modelIds).toContain('chatgpt-image-latest');
    expect(modelIds).toContain('dall-e-3');

    const imageModel = models.find((model) => model.modelId === 'gpt-image-2');
    expect(imageModel?.capabilities?.image).toBe(true);
    expect(imageModel?.capabilities?.text).toBe(false);
    expect(imageModel?.capabilities?.streaming).toBe(false);
  });

  it('does not duplicate image models returned by OpenAI', () => {
    const models = includeKnownOpenAIImageModels([makeTextModel('gpt-image-2')]);
    const matchingModels = models.filter((model) => model.modelId === 'gpt-image-2');

    expect(matchingModels).toHaveLength(1);
  });
});
