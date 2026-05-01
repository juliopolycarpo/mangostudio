import { describe, expect, it } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { AddConnectorBodySchema } from '@mangostudio/shared/connectors';

import { validateDeepSeekApiKey } from '../../../../src/services/providers/deepseek/client';
import {
  fetchDeepSeekModels,
  getDeepSeekFallbackModels,
  toDeepSeekModelInfo,
} from '../../../../src/services/providers/deepseek/model-catalog';

function createModelListFetch(
  status = 200
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }],
        }),
        { status, headers: { 'Content-Type': 'application/json' } }
      )
    );
}

describe('DeepSeek provider foundation', () => {
  it('accepts deepseek in connector contracts', () => {
    expect(
      Value.Check(AddConnectorBodySchema, {
        name: 'personal',
        apiKey: 'sk-test-key',
        source: 'bun-secrets',
        provider: 'deepseek',
      })
    ).toBe(true);
  });

  it('validates API keys through the DeepSeek models endpoint', async () => {
    await validateDeepSeekApiKey({ apiKey: 'sk-test-key', fetchImpl: createModelListFetch() });
  });

  it('maps discovered models to DeepSeek capabilities', async () => {
    const models = await fetchDeepSeekModels({
      apiKey: 'sk-test-key',
      fetchImpl: createModelListFetch(),
    });

    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      modelId: 'deepseek-v4-flash',
      provider: 'deepseek',
      inputTokenLimit: 1_048_576,
      capabilities: {
        text: true,
        streaming: true,
        reasoning: true,
        tools: true,
        statefulContinuation: false,
        promptCaching: true,
        reasoningWithTools: true,
        structuredOutput: true,
      },
    });
  });

  it('marks compatibility aliases with safe capabilities', () => {
    expect(toDeepSeekModelInfo('deepseek-reasoner')).toMatchObject({
      capabilities: { reasoning: true, tools: false, reasoningWithTools: false },
    });
    expect(getDeepSeekFallbackModels().map((model) => model.modelId)).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-chat',
      'deepseek-reasoner',
    ]);
  });
});
