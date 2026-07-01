import { describe, expect, it } from 'bun:test';
import { getProviderRuntimeAvailability } from '../../../../src/services/providers/core/provider-settings-policy';
import {
  getCursorFallbackModels,
  toCursorModelInfo,
} from '../../../../src/services/providers/cursor/model-catalog';
import { buildCursorAgentPrompt } from '../../../../src/services/providers/cursor/prompt-builder';

describe('cursor provider foundation', () => {
  it('maps cursor models to text streaming capabilities', () => {
    const model = toCursorModelInfo('composer-2.5');
    expect(model.provider).toBe('cursor');
    expect(model.capabilities.text).toBe(true);
    expect(model.capabilities.streaming).toBe(true);
    expect(model.capabilities.tools).toBe(false);
  });

  it('provides fallback models when discovery is unavailable', () => {
    const models = getCursorFallbackModels();
    expect(models.map((model) => model.modelId)).toEqual(['composer-2.5', 'auto']);
  });

  it('builds a flattened prompt from system, history, and user input', () => {
    const prompt = buildCursorAgentPrompt({
      systemPrompt: 'Be concise.',
      history: [
        { role: 'user', text: 'Hello' },
        { role: 'ai', text: 'Hi there.' },
      ],
      prompt: 'Summarize the repo.',
    });

    expect(prompt).toContain('System instructions:\nBe concise.');
    expect(prompt).toContain('User: Hello');
    expect(prompt).toContain('Assistant: Hi there.');
    expect(prompt).toContain('User: Summarize the repo.');
  });

  it('exposes runtime availability for the cursor provider descriptor', async () => {
    const runtime = await getProviderRuntimeAvailability('cursor');
    expect(typeof runtime.runtimeAvailable).toBe('boolean');
    if (!runtime.runtimeAvailable) {
      expect(runtime.runtimeUnavailableReason).toContain('NodeJS');
    }
  });

  it('marks non-cursor providers as runtime-available', async () => {
    expect(await getProviderRuntimeAvailability('openai')).toEqual({ runtimeAvailable: true });
  });
});
